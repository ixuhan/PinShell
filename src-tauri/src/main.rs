#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use core_domain::osc::{OscEvent, OscParser};
use core_domain::ownership::{
    decide, is_submit, Confidence, Override, Owner, PromptTracker, TerminalState, TransportKind,
};
use core_domain::replay::ReplayBuffer;
use core_domain::utf8_stream::Utf8Stream;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

mod persistence;

/// 一个会话的运行时句柄。输入所有权、状态机等后续模块都挂在这里。
struct Session {
    /// 会话树里显示的名字：M2 先用 Shell 文件名，重命名留给会话树
    title: String,
    created_ms: u64,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    input: Mutex<InputState>,
    /// 输入条提交过的行，内存里最近 200 条。落盘与掩码是 M3 的事。
    history: Mutex<VecDeque<String>>,
    /// 最近输出的副本：前端晚附着、切走或页面重载后从这里补上一段
    replay: Mutex<ReplayBuffer>,
}

/// 每个会话保留多少回放字节。够覆盖一次重载与切会话的空档，又不至于长住内存。
const REPLAY_CAP_BYTES: usize = 256 * 1024;

/// 输入条历史的上限：只服务 ↑↓ 的即时手感，不做持久化。
const HISTORY_CAP: usize = 200;

/// 输入判定状态：状态机 + 用户显式覆盖 + 去重用的上一帧。
struct InputState {
    tracker: PromptTracker,
    ovr: Override,
    last_sent: Option<OwnershipPayload>,
    /// 最近一次收到输出的时刻（毫秒时间戳），供「静默猜测」使用
    last_output_ms: u64,
    /// 最近一块输出是否以换行结尾，供「静默猜测」的「行首」条件使用
    at_line_start: bool,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Clone, Serialize)]
struct OutPayload {
    id: String,
    /// 会话内递增，前端用它与回放快照去重
    seq: u64,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
}

/// 附着时拿到的回放快照：`data` 覆盖到 `seq` 为止。
#[derive(Serialize)]
struct ReplayPayload {
    id: String,
    seq: u64,
    data: String,
    dropped_bytes: u64,
}

/// 会话列表的一行。冷会话与重命名是 M2 后半段的事，这里只有活着的会话。
#[derive(Serialize)]
struct SessionInfo {
    id: String,
    title: String,
    state: &'static str,
    created_ms: u64,
}

/// 从输出流里摘出来的标记，前端只消费它，不再自己解析字节。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MarkerPayload {
    PromptStart,
    PromptEnd,
    CommandStart,
    CommandEnd { code: Option<i32> },
    Cwd { path: String },
    Title { text: String },
    AltScreen { entered: bool },
}

#[derive(Clone, Serialize)]
struct MarkerEvent {
    id: String,
    marker: MarkerPayload,
}

/// 按键归属的裁定结果。前端只跟着它切换焦点，不再自己算一遍规则。
#[derive(Clone, Serialize, PartialEq)]
struct OwnershipPayload {
    id: String,
    owner: &'static str,
    confidence: &'static str,
    state: &'static str,
    #[serde(rename = "override")]
    ovr: &'static str,
}

fn marker_of(ev: OscEvent) -> Option<MarkerPayload> {
    Some(match ev {
        OscEvent::PromptStart => MarkerPayload::PromptStart,
        OscEvent::PromptEnd => MarkerPayload::PromptEnd,
        OscEvent::CommandStart => MarkerPayload::CommandStart,
        OscEvent::CommandEnd { code } => MarkerPayload::CommandEnd { code },
        OscEvent::Cwd(path) => MarkerPayload::Cwd { path },
        OscEvent::Title(text) => MarkerPayload::Title { text },
        OscEvent::AltScreen { entered } => MarkerPayload::AltScreen { entered },
        // 其它 OSC 只用于排查，没有消费方，不进事件流
        OscEvent::Other(_) => return None,
    })
}

fn owner_name(owner: Owner) -> &'static str {
    match owner {
        Owner::InputBar => "input_bar",
        Owner::Channel => "channel",
    }
}

fn confidence_name(confidence: Confidence) -> &'static str {
    match confidence {
        Confidence::Certain => "certain",
        Confidence::Guess => "guess",
    }
}

fn state_name(state: TerminalState) -> &'static str {
    match state {
        TerminalState::Unknown => "unknown",
        TerminalState::PromptGuess => "prompt_guess",
        TerminalState::PromptReady => "prompt_ready",
        TerminalState::Running => "running",
        TerminalState::AltScreen => "alt_screen",
    }
}

fn override_name(ovr: Override) -> &'static str {
    match ovr {
        Override::None => "none",
        Override::ForceInputBar => "input_bar",
        Override::ForcePassthrough => "passthrough",
    }
}

fn override_from_str(mode: &str) -> Result<Override, String> {
    match mode {
        "none" => Ok(Override::None),
        "input_bar" => Ok(Override::ForceInputBar),
        "passthrough" => Ok(Override::ForcePassthrough),
        other => Err(format!("unknown override {other}")),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 当前判定。唯一的规则来源是 `core_domain::ownership::decide`。
fn ownership_of(id: &str, input: &InputState) -> OwnershipPayload {
    let state = input.tracker.view();
    let decision = decide(TransportKind::Terminal, state, input.ovr);
    OwnershipPayload {
        id: id.to_string(),
        owner: owner_name(decision.owner),
        confidence: confidence_name(decision.confidence),
        state: state_name(state),
        ovr: override_name(input.ovr),
    }
}

/// 只在判定变化时推送：按键路径不允许有逐键 IPC。
fn push_ownership(app: &AppHandle, session: &Session, id: &str) {
    let payload = {
        let mut input = session.input.lock();
        let current = ownership_of(id, &input);
        if input.last_sent.as_ref() == Some(&current) {
            return;
        }
        input.last_sent = Some(current.clone());
        current
    };
    // 进 dev 的终端日志，方便肉眼确认判定在变
    println!(
        "[own] {} {}/{}{}",
        &payload.id[..payload.id.len().min(8)],
        payload.state,
        payload.owner,
        if payload.confidence == "guess" { " (guess)" } else { "" }
    );
    let _ = app.emit("pty:ownership", payload);
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn resolve_shell(preferred: Option<String>) -> String {
    // 开发期临时换 shell：PINSHELL_SHELL=... 不改代码也不动设置
    let preferred = preferred.or_else(|| std::env::var("PINSHELL_SHELL").ok());
    if let Some(s) = preferred.filter(|s| !s.trim().is_empty()) {
        return s;
    }
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if on_path(candidate) {
            return candidate.to_string();
        }
    }
    "cmd.exe".to_string()
}

fn is_powershell(shell: &str) -> bool {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe"
    )
}

fn is_bash(shell: &str) -> bool {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    matches!(name.as_str(), "bash" | "bash.exe")
}

/// 集成脚本的位置：安装版取资源目录，开发版回退到仓库里的脚本。
fn integration_script(app: &AppHandle, name: &str) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("integration").join(name);
        if packaged.is_file() {
            return Some(packaged);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("integration")
            .join(name);
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}

/// 把路径塞进 PowerShell 单引号字符串里。
fn ps_literal(path: &Path) -> String {
    format!(". '{}'", path.display().to_string().replace('\'', "''"))
}

#[tauri::command]
fn spawn_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let shell = resolve_shell(shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        cmd.cwd(dir);
    }

    // 集成脚本只注入我们自己启动的进程：不写用户 profile、不写注册表（ADR 0003）
    if is_powershell(&shell) {
        if let Some(script) = integration_script(&app, "pinshell.ps1") {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(ps_literal(&script));
        }
    } else if is_bash(&shell) {
        // --init-file 会顶掉默认启动文件，所以脚本自己先读 /etc/profile 与 ~/.bashrc
        if let Some(script) = integration_script(&app, "pinshell.bash") {
            cmd.arg("--init-file");
            cmd.arg(script);
            cmd.arg("-i");
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {shell}: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let id = Uuid::new_v4().to_string();
    let title = Path::new(&shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(shell.as_str())
        .to_string();
    let session = Arc::new(Session {
        title,
        created_ms: now_ms(),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        input: Mutex::new(InputState {
            tracker: PromptTracker::new(),
            ovr: Override::None,
            last_sent: None,
            last_output_ms: now_ms(),
            at_line_start: true,
        }),
        history: Mutex::new(VecDeque::new()),
        replay: Mutex::new(ReplayBuffer::new(REPLAY_CAP_BYTES)),
    });
    state.sessions.lock().insert(id.clone(), session.clone());

    // 每个会话一个读线程（ConPTY 要求读写分离，否则死锁）
    let app_for_read = app.clone();
    let session_for_read = session.clone();
    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut stream = Utf8Stream::new();
        let mut parser = OscParser::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let events = parser.feed(&buf[..n]);
                    {
                        let mut input = session_for_read.input.lock();
                        input.last_output_ms = now_ms();
                        input.at_line_start = matches!(buf[..n].last(), Some(b'\n') | Some(b'\r'));
                        for ev in &events {
                            input.tracker.on_event(ev);
                        }
                    }
                    // 先推进标记，再发字节：状态变化不晚于屏幕变化
                    if !events.is_empty() {
                        for ev in events {
                            if let Some(marker) = marker_of(ev) {
                                let _ = app_for_read.emit(
                                    "pty:marker",
                                    MarkerEvent {
                                        id: emit_id.clone(),
                                        marker,
                                    },
                                );
                            }
                        }
                        push_ownership(&app_for_read, &session_for_read, &emit_id);
                    }
                    let text = stream.push(&buf[..n]);
                    if !text.is_empty() {
                        // 先记回放再发事件：凡是被前端看到过的块，一定也能被回放到
                        let seq = session_for_read
                            .replay
                            .lock()
                            .push(&text)
                            .unwrap_or_default();
                        let _ = app_for_read.emit(
                            "pty:out",
                            OutPayload {
                                id: emit_id.clone(),
                                seq,
                                data: text,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_read.emit("pty:exit", ExitPayload { id: emit_id });
    });

    // 静默猜测：没有集成脚本时，静默够久且光标在行首才给出「猜测」（只影响状态点颜色）
    let weak: Weak<Session> = Arc::downgrade(&session);
    let app_for_tick = app.clone();
    let tick_id = id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Some(session) = weak.upgrade() else { break };
        {
            let mut input = session.input.lock();
            let quiet = now_ms().saturating_sub(input.last_output_ms);
            let at_line_start = input.at_line_start;
            input.tracker.on_silence(quiet, at_line_start);
        }
        push_ownership(&app_for_tick, &session, &tick_id);
    });

    push_ownership(&app, &session, &id);
    Ok(id)
}

/// 写入会话的公共路径。`from_bar` 决定这条命令要不要进输入条历史。
fn write_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
    data: &str,
    from_bar: bool,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;

    // 提交意图先于字节生效：回车一按就停止接管，比等标记回来更保守
    if is_submit(data) {
        session.input.lock().tracker.on_submit();
        push_ownership(app, &session, id);
        if from_bar {
            remember(&session, data);
        }
    }

    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("write: {e}"))
}

#[tauri::command]
fn pty_write(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    write_session(&app, &state, &id, &data, false)
}

/// 输入条提交一行：与逐键写入走同一条路径，额外记历史。
#[tauri::command]
fn pty_send_line(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    line: String,
) -> Result<(), String> {
    write_session(&app, &state, &id, &format!("{line}\r"), true)
}

/// 记下输入条提交的一行。只进内存，不落盘；规则在 `core_domain::history`。
fn remember(session: &Session, data: &str) {
    core_domain::history::remember(&mut session.history.lock(), data, HISTORY_CAP);
}

/// 输入条历史，按时间顺序（最后一条是最近的）。
#[tauri::command]
fn pty_history(state: State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let items: Vec<String> = session.history.lock().iter().cloned().collect();
    Ok(items)
}

/// 附着时补画：`data` 覆盖到 `seq` 为止，之后只渲染 `seq` 更大的实时块。
#[tauri::command]
fn pty_replay(state: State<'_, AppState>, id: String) -> Result<ReplayPayload, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let snapshot = session.replay.lock().snapshot();
    Ok(ReplayPayload {
        id,
        seq: snapshot.seq,
        data: snapshot.text,
        dropped_bytes: snapshot.dropped_bytes,
    })
}

/// 活着的会话列表，按创建顺序。页面重载后靠它决定「挂回」还是「新开」。
#[tauri::command]
fn pty_list(state: State<'_, AppState>) -> Vec<SessionInfo> {
    let sessions = state.sessions.lock();
    let mut list: Vec<SessionInfo> = sessions
        .iter()
        .map(|(id, session)| SessionInfo {
            id: id.clone(),
            title: session.title.clone(),
            state: state_name(session.input.lock().tracker.view()),
            created_ms: session.created_ms,
        })
        .collect();
    list.sort_by_key(|info| info.created_ms);
    list
}

#[tauri::command]
fn pty_set_override(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mode: String,
) -> Result<(), String> {
    let ovr = override_from_str(&mode)?;
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    session.input.lock().ovr = ovr;
    push_ownership(&app, &session, &id);
    Ok(())
}

/// 当前判定。订阅比会话晚一步时用它补一帧，避免前端停在默认值上。
#[tauri::command]
fn pty_ownership(state: State<'_, AppState>, id: String) -> Result<OwnershipPayload, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let input = session.input.lock();
    Ok(ownership_of(&id, &input))
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let master = session.master.lock();
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().remove(&id) {
        let _ = session.child.lock().kill();
    }
    Ok(())
}

/// 空命令，用于测 IPC 往返开销。
#[tauri::command]
fn bench_ping() {}

/// 前端把基准结果回传到 stdout，便于在 tauri dev 的终端里直接读到
#[tauri::command]
fn bench_report(text: String) {
    println!("[bench] {text}");
}

fn main() {
    // 数据目录只在启动时解析一次：便携优先，不可写才回退 %APPDATA%。
    // 解析失败不挡启动（本版还没有必需落盘的状态），只把原因记到 stdout。
    match persistence::data_dir() {
        Ok(dir) => {
            println!("[data] {}", dir.display());
            match persistence::load_workspace(&dir) {
                persistence::WorkspaceLoad::Loaded(ws) => println!(
                    "[data] workspace: {} window(s), {} session(s)",
                    ws.windows.len(),
                    ws.sessions.len()
                ),
                persistence::WorkspaceLoad::Recovered(ws) => println!(
                    "[data] workspace recovered from .bak: {} session(s)",
                    ws.sessions.len()
                ),
                persistence::WorkspaceLoad::Missing => println!("[data] workspace: first run"),
                persistence::WorkspaceLoad::Unreadable(err) => {
                    eprintln!("[data] workspace unreadable: {err}")
                }
            }
        }
        Err(err) => eprintln!("[data] {err}"),
    }

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            pty_write,
            pty_send_line,
            pty_set_override,
            pty_ownership,
            pty_history,
            pty_replay,
            pty_list,
            pty_resize,
            pty_close,
            bench_ping,
            bench_report
        ])
        // 退出应用 = 结束全部进程（I3）。页面重载不是退出，会话要留着等前端挂回。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                for (_, session) in state.sessions.lock().drain() {
                    let _ = session.child.lock().kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PinShell");
}
