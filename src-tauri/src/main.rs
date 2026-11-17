#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use core_domain::coalesce::Coalescer;
use core_domain::osc::{OscEvent, OscParser};
use core_domain::ownership::{
    decide, is_submit, Confidence, Override, Owner, PromptTracker, TerminalState, TransportKind,
};
use core_domain::replay::ReplayBuffer;
use core_domain::resize::SentSize;
use core_domain::utf8_stream::Utf8Stream;
use core_domain::workspace::{SessionMeta, Workspace};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

mod history;
mod persistence;

/// 一个会话的运行时句柄。输入所有权、状态机等后续模块都挂在这里。
/// 标题不在这里：唯一真源是工作区里的 `SessionMeta`，见 `pty_list`。
struct Session {
    created_ms: u64,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    input: Mutex<InputState>,
    /// 最近输出的副本：前端晚附着、切走或页面重载后从这里补上一段
    replay: Mutex<ReplayBuffer>,
    /// 回放缓冲自上次落盘以来有没有新内容（空闲落盘用，见 `IDLE_FLUSH_MS`）
    dirty: AtomicBool,
    /// 暂停接收输出：读线程照常解析、照常记回放，只是不再发 `pty:out`。
    /// 继续时前端按回放整屏重画，所以暂停期间的输出不丢、也不会与 Shell 的屏幕错位。
    paused: AtomicBool,
    /// 最近一次生效的 PTY 尺寸。相同尺寸不再下发：ConPTY 每次 resize 都会整屏重绘，
    /// 会把刚清掉的屏幕又画回来（见 `core_domain::resize`）。
    size: Mutex<SentSize>,
    /// 输出合流：读线程只往里追加，发送线程按帧把攒下的块发一次 `pty:out`。
    /// 刷屏时读循环一秒能读到上千块，逐块发事件会把主线程和前端压满（见 `core_domain::coalesce`）。
    outbox: Arc<OutMailbox>,
}

/// 合流缓冲 + 发送线程共享的运行标志。读线程结束时 `running` 置 false，
/// 发送线程把最后一块发出去后自行退出。
struct OutMailbox {
    pending: Mutex<Coalescer>,
    running: AtomicBool,
}

/// 发送线程的唤醒间隔（毫秒）。8 ms 比一帧（16.7 ms）短，屏幕不会因此变慢；
/// 又足以把刷屏时的上千次读合成几十次事件。
const OUT_COALESCE_MS: u64 = 8;

/// 每个会话保留多少回放字节。够覆盖一次重载与切会话的空档，又不至于长住内存。
const REPLAY_CAP_BYTES: usize = 256 * 1024;

/// 输出静默多久之后才把卷轴快照落盘。太短会在持续刷屏时反复写文件，
/// 太长则崩溃退出会丢更多屏幕内容。3 秒是「用户已经看完这段话」的量级。
const IDLE_FLUSH_MS: u64 = 3000;

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

struct AppState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// 会话树与布局。内存是唯一写入口，落盘由 [`persist_workspace`] 统一做。
    workspace: Mutex<Workspace>,
    /// 解析失败时为 `None`：本版没有必需落盘的状态，不挡启动
    data_dir: Option<PathBuf>,
    /// 历史库句柄。`setup` 里拿到 `AppHandle` 后才建（写库线程要发事件）。
    history: OnceLock<Arc<history::History>>,
}

impl AppState {
    fn new(data_dir: Option<PathBuf>, workspace: Workspace) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            workspace: Mutex::new(workspace),
            data_dir,
            history: OnceLock::new(),
        }
    }

    fn history(&self) -> Option<&Arc<history::History>> {
        self.history.get()
    }
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

/// 附着时拿到的历史快照（L2-02）：`items` 按 id 升序，`upto_id` 是快照时的最大 id。
#[derive(Serialize)]
struct HistorySnapshotPayload {
    session_id: String,
    upto_id: i64,
    items: Vec<history::HistoryItem>,
}

/// 会话列表的一行。冷会话与重命名是 M2 后半段的事，这里只有活着的会话。
#[derive(Serialize)]
struct SessionInfo {
    id: String,
    title: String,
    state: &'static str,
    created_ms: u64,
}

/// 会话树的一行：冷会话也在里面。热/冷由前端对照 `pty_list` 得出，
/// 这里不重复给一份 `hot`（工作区里的 `hot` 只服务于退出时的落盘）。
#[derive(Serialize)]
struct TreeSession {
    id: String,
    title: String,
    transport: &'static str,
    shell: Option<String>,
    cwd: Option<String>,
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

/// 工作区落盘。失败只记日志：磁盘问题不该让会话操作失败。
fn persist_workspace(state: &AppState) {
    let Some(dir) = state.data_dir.as_deref() else {
        return;
    };
    let workspace = state.workspace.lock();
    if let Err(err) = persistence::save_workspace(dir, &workspace) {
        eprintln!("[data] save workspace: {err}");
    }
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

/// PowerShell 集成脚本的正文。优先读磁盘（改了脚本不用重编），读不到用编译期内嵌的副本。
///
/// 注入的是**正文**而不是「`.` 一个 .ps1 文件」：点源文件要先过 PowerShell 的授权检查，
/// 该检查在部分机器上会直接失败（输出 `AuthorizationManager 检查失败。`），
/// 脚本于是整段没跑、会话永远停在「未知 · 直通」。正文走 `-EncodedCommand`，不经那条路径。
fn powershell_integration_text(app: &AppHandle) -> String {
    if let Some(path) = integration_script(app, "pinshell.ps1") {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return text;
        }
    }
    include_str!("../../scripts/integration/pinshell.ps1").to_string()
}

/// 标准 base64（RFC 4648，带 `=` 填充）。只服务 `-EncodedCommand`，不为它引依赖。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(n >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// `-EncodedCommand` 要的形态：UTF-16LE 字节的 base64。
fn powershell_encoded(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64_encode(&bytes)
}

#[tauri::command]
fn spawn_session(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    // 同一个 id 只能是冷会话被重新拉起；已在运行的不能重复拉起，否则旧进程会失联
    if let Some(id) = session_id.as_deref() {
        if state.sessions.lock().contains_key(id) {
            return Err(format!("session {id} is already live"));
        }
    }

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
    let cwd = cwd.filter(|d| !d.trim().is_empty());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = &cwd {
        cmd.cwd(dir.as_str());
    }

    // 集成脚本只注入我们自己启动的进程：不写用户 profile、不写注册表（ADR 0003）
    if is_powershell(&shell) {
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
        cmd.arg("-EncodedCommand");
        cmd.arg(powershell_encoded(&powershell_integration_text(&app)));
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

    let id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let title = Path::new(&shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(shell.as_str())
        .to_string();
    let outbox = Arc::new(OutMailbox {
        pending: Mutex::new(Coalescer::new()),
        running: AtomicBool::new(true),
    });
    let session = Arc::new(Session {
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
        replay: Mutex::new(ReplayBuffer::new(REPLAY_CAP_BYTES)),
        dirty: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        size: Mutex::new(SentSize::seeded(cols.max(1), rows.max(1))),
        outbox: outbox.clone(),
    });

    // 冷会话重开：把上次的屏幕接在新输出前面。必须在读线程启动前做，
    // 否则新输出会先占序号、快照反而画在后面。
    if let Some(dir) = state.data_dir.as_deref() {
        if let Some(previous) = persistence::load_scrollback(dir, &id) {
            let seeded = core_domain::scrollback::compose(&previous);
            if !seeded.is_empty() {
                session.replay.lock().push(&seeded);
            }
        }
    }

    state.sessions.lock().insert(id.clone(), session.clone());

    // 会话树：同一个 id 可能是冷会话被重新拉起，更新而不是新增
    {
        let mut workspace = state.workspace.lock();
        match workspace.session_mut(&id) {
            Some(meta) => {
                // 名字不覆盖：用户改过的标题比 Shell 文件名重要
                meta.transport = TransportKind::Terminal;
                // 目录没指定（冷会话在默认目录重开）就保留原来记住的那个
                if cwd.is_some() {
                    meta.cwd = cwd.clone();
                }
                meta.shell = Some(shell.clone());
                meta.hot = true;
            }
            None => {
                let mut meta = SessionMeta::terminal(id.clone(), title.clone(), shell.clone());
                meta.cwd = cwd.clone();
                meta.hot = true;
                let _ = workspace.add_session(meta);
            }
        }
    }
    persist_workspace(&state);

    // 输出发送线程：每 OUT_COALESCE_MS 把合流缓冲攒下的块发一次 `pty:out`。
    // 暂停期间直接丢掉攒下的块（内容在回放缓冲里，继续时整屏重画），
    // 否则长时间暂停会让缓冲一直长。
    {
        let app_for_out = app.clone();
        let session_for_out = session.clone();
        let out_id = id.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(OUT_COALESCE_MS));
            let running = session_for_out.outbox.running.load(Ordering::Relaxed);
            if let Some((data, seq)) = session_for_out.outbox.pending.lock().take() {
                if !session_for_out.paused.load(Ordering::Relaxed) {
                    let _ = app_for_out.emit(
                        "pty:out",
                        OutPayload {
                            id: out_id.clone(),
                            seq,
                            data,
                        },
                    );
                }
            }
            if !running {
                break;
            }
        });
    }

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
                                // CWD 跟随：记住最后一次上报，冷会话重开时用它做启动目录
                                if let MarkerPayload::Cwd { path } = &marker {
                                    note_cwd(&app_for_read, &emit_id, path);
                                }
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
                        session_for_read.dirty.store(true, Ordering::Relaxed);
                        // 暂停只掐事件，不掐回放：继续时前端按回放整屏重画，暂停期间的内容
                        // 还在（受 REPLAY_CAP_BYTES 限制，超出部分按整块丢）。这样既省掉
                        // 刷屏时的 IPC，又不会让暂停期间的终端查询（DSR 之类）永远丢答。
                        //
                        // 事件不在这里直接发：先攒进合流缓冲，由发送线程按帧发出去。
                        // 刷屏时这里一秒会跑上千次，逐块发 IPC 的代价全落在主线程与前端。
                        session_for_read.outbox.pending.lock().push(&text, seq);
                    }
                }
                Err(_) => break,
            }
        }
        // 读循环结束：先停发送线程，再把最后一块发出去，最后才发退出事件。
        // 顺序反了会让屏幕上的最后一段内容落在「[进程已退出]」之后。
        session_for_read.outbox.running.store(false, Ordering::Relaxed);
        if let Some((data, seq)) = session_for_read.outbox.pending.lock().take() {
            if !session_for_read.paused.load(Ordering::Relaxed) {
                let _ = app_for_read.emit(
                    "pty:out",
                    OutPayload {
                        id: emit_id.clone(),
                        seq,
                        data,
                    },
                );
            }
        }
        // 通道结束（进程退出/被关）：先落卷轴快照、摘掉运行时、标记冷会话，再通知前端
        {
            let state = app_for_read.state::<AppState>();
            // 用户主动关闭的会话，节点已经删掉，不再补一份快照回来（I2）。
            // 单独取值：不能让 workspace 的锁活在条件里，下面还要再取一次。
            let still_known = state.workspace.lock().session(&emit_id).is_some();
            if still_known {
                save_session_scrollback(&state, &session_for_read, &emit_id);
            }
            state.sessions.lock().remove(&emit_id);
            {
                let mut workspace = state.workspace.lock();
                let _ = workspace.set_hot(&emit_id, false);
            }
            persist_workspace(&state);
        }
        let _ = app_for_read.emit("pty:exit", ExitPayload { id: emit_id });
    });

    // 后台滴答：静默猜测 + 空闲落盘（崩溃退出最多丢 IDLE_FLUSH_MS 毫秒的屏幕）
    let weak: Weak<Session> = Arc::downgrade(&session);
    let app_for_tick = app.clone();
    let tick_id = id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Some(session) = weak.upgrade() else { break };
        let quiet = {
            let mut input = session.input.lock();
            let quiet = now_ms().saturating_sub(input.last_output_ms);
            let at_line_start = input.at_line_start;
            input.tracker.on_silence(quiet, at_line_start);
            quiet
        };
        push_ownership(&app_for_tick, &session, &tick_id);

        // 只在「有未落盘的新内容」且「已经静默够久」时写一次：
        // 连续刷屏时不会反复写盘，崩溃时也只丢最后几秒
        if quiet >= IDLE_FLUSH_MS && session.dirty.swap(false, Ordering::Relaxed) {
            let state = app_for_tick.state::<AppState>();
            if !save_session_scrollback(&state, &session, &tick_id) {
                // 没写成（没有数据目录/磁盘忙）：留到下一个滴答再试
                session.dirty.store(true, Ordering::Relaxed);
            }
        }
    });

    push_ownership(&app, &session, &id);
    Ok(id)
}

/// 把会话当前的可见内容落成卷轴快照。只在数据目录可用、且回放缓冲里确实有内容时才写。
/// 返回是否真的写了文件：空闲落盘靠它决定还要不要再试一次。
/// 快照只用于显示：冷会话重新拉起时接在新输出前面（见 `core_domain::scrollback`）。
fn save_session_scrollback(state: &AppState, session: &Session, id: &str) -> bool {
    let Some(dir) = state.data_dir.as_deref() else {
        return false;
    };
    let text = session.replay.lock().snapshot().text;
    if text.is_empty() {
        return false;
    }
    match persistence::save_scrollback(dir, id, &text) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[data] save scrollback {id}: {err}");
            false
        }
    }
}

/// 跟随 Shell 上报的 CWD，写进会话树（冷会话重开时用它做启动目录）。
/// 只在目录真的变了时落盘：提示符每次都会上报一遍，不该每次都写文件。
fn note_cwd(app: &AppHandle, id: &str, path: &str) {
    let state = app.state::<AppState>();
    let changed = {
        let mut workspace = state.workspace.lock();
        workspace.set_cwd(id, path).unwrap_or(false)
    };
    if changed {
        persist_workspace(&state);
    }
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
    }

    {
        let mut writer = session.writer.lock();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("write: {e}"))?;
    }

    // 先发 PTY、再排进历史库的单写线程：落盘失败不影响命令已经发出去（M3）
    if from_bar {
        if let Some(history) = state.history() {
            history.record(id, data, now_ms());
        }
    }
    Ok(())
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

/// 输入条历史，按时间顺序（最后一条是最近的）。↑↓ 只用最近 5000 条。
#[tauri::command]
fn pty_history(state: State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    if !state.sessions.lock().contains_key(&id) {
        return Err(format!("no session {id}"));
    }
    let Some(history) = state.history() else {
        return Ok(Vec::new());
    };
    let (items, _) = history.snapshot(&id);
    Ok(items.into_iter().map(|entry| entry.command).collect())
}

/// 历史缓存契约（L2-02）：附着时整份取最近 5000 条，之后靠 `history:append` 增量补齐。
#[tauri::command]
fn history_snapshot(state: State<'_, AppState>, id: String) -> HistorySnapshotPayload {
    let (items, upto) = match state.history() {
        Some(history) => history.snapshot(&id),
        None => (Vec::new(), 0),
    };
    HistorySnapshotPayload {
        session_id: id,
        upto_id: upto,
        items: items.into_iter().map(history::HistoryItem::from).collect(),
    }
}

/// Ctrl+R 的全量检索（前端本地先过滤 5000 条，防抖后再来查这里）。
#[tauri::command]
fn history_search(
    state: State<'_, AppState>,
    id: String,
    query: String,
) -> Vec<history::HistoryItem> {
    state
        .history()
        .map(|history| {
            history
                .search(&id, &query)
                .into_iter()
                .map(history::HistoryItem::from)
                .collect()
        })
        .unwrap_or_default()
}

/// 清空本会话历史：不动别的会话，也不动工作区里的会话节点。
#[tauri::command]
fn history_clear(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(history) = state.history() {
        history.clear(&id);
    }
    Ok(())
}

/// 附着时补画：`data` 覆盖到 `seq` 为止，之后只渲染 `seq` 更大的实时块。
///
/// `answered_seq` 是前端已经画到过的最大序号：以它为界，画过的块里的终端查询要删掉
/// （答过的不再答），没画过的块原样交回（可能正等着终端应答，删了 Shell 会卡住）。
#[tauri::command]
fn pty_replay(
    state: State<'_, AppState>,
    id: String,
    answered_seq: Option<u64>,
) -> Result<ReplayPayload, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let snapshot = session
        .replay
        .lock()
        .snapshot_for_attach(answered_seq.unwrap_or(0));
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
    let workspace = state.workspace.lock();
    let mut list: Vec<SessionInfo> = sessions
        .iter()
        .map(|(id, session)| SessionInfo {
            id: id.clone(),
            // 标题的唯一真源是工作区：重命名与冷会话重开都读这一份
            title: workspace
                .session(id)
                .map(|meta| meta.title.clone())
                .unwrap_or_else(|| id.clone()),
            state: state_name(session.input.lock().tracker.view()),
            created_ms: session.created_ms,
        })
        .collect();
    list.sort_by_key(|info| info.created_ms);
    list
}

/// 完整会话树（含冷会话），顺序即创建顺序。侧栏用它渲染。
#[tauri::command]
fn session_tree(state: State<'_, AppState>) -> Vec<TreeSession> {
    let workspace = state.workspace.lock();
    workspace
        .sessions
        .iter()
        .map(|session| TreeSession {
            id: session.id.clone(),
            title: session.title.clone(),
            transport: session.transport.as_str(),
            shell: session.shell.clone(),
            cwd: session.cwd.clone(),
        })
        .collect()
}

/// 改会话标题。规则（去空白、按字符截断）在 core-domain；这里只负责落盘。
/// 标题的唯一真源是工作区，`pty_list` 也从那里读，不存在第二份要同步的名字。
#[tauri::command]
fn rename_session(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    let changed = {
        let mut workspace = state.workspace.lock();
        workspace
            .rename_session(&id, &title)
            .map_err(|err| format!("rename: {err:?}"))?
    };
    if changed {
        persist_workspace(&state);
    }
    Ok(())
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

/// 暂停 / 继续接收输出。返回设置后的状态，前端不必再查一次。
/// 判定在后端读线程：暂停期间不再发 `pty:out`（省掉刷屏时的 IPC），输出继续进回放缓冲。
#[tauri::command]
fn pty_set_paused(state: State<'_, AppState>, id: String, paused: bool) -> Result<bool, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    session.paused.store(paused, Ordering::Relaxed);
    // 攒着的块：暂停时发出去也没人画，继续时前端按回放整屏重画（再发就等于画两遍）。
    // 直接丢掉，省掉长时间暂停时的内存。
    session.outbox.pending.lock().clear();
    Ok(paused)
}

/// 当前是否暂停。切会话回来时要按后端状态复原按钮，不能凭前端记忆。
#[tauri::command]
fn pty_paused(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    Ok(session.paused.load(Ordering::Relaxed))
}

/// 清窗口：丢掉回放内容并删掉磁盘上的卷轴快照，屏幕由前端自己清。
/// 序号继续往前走（见 `ReplayBuffer::clear`），所以清掉的块不会被当成新内容补画回来；
/// 重载页面、重开应用也不会再把旧内容画回来。
/// 返回清空前的最后序号：前端拿它把「已经发出去、还在路上」的旧块一起丢掉。
#[tauri::command]
fn pty_clear(state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let seq = session.replay.lock().clear();
    // 合流缓冲里可能还压着清屏前读到的块。不清掉的话，它们会在下一次发送时
    // 带着更大的 seq 落到刚清空的屏幕上（前端只比 seq，不会知道那是旧内容）。
    session.outbox.pending.lock().clear();
    // 清完立刻把「有未落盘内容」还回去：否则下一个空闲滴答会把空快照当成一次写盘
    session.dirty.store(false, Ordering::Relaxed);
    if let Some(dir) = state.data_dir.as_deref() {
        if let Err(err) = persistence::remove_scrollback(dir, &id) {
            eprintln!("[data] remove scrollback {id}: {err}");
        }
    }
    Ok(seq)
}
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

/// 改 PTY 尺寸。**相同尺寸不下发**：ConPTY 每收到一次 resize（哪怕没变）都会整屏重绘
/// 自己的缓冲，把「清屏」清掉的内容重新吐回来（暂停 → 清屏 → 继续 就是这么复现的）。
/// 重新附着与继续都不该顺手 resize，只有真实的窗口尺寸变化才下发，规则见 `core_domain::resize`。
#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let want = (cols.max(1), rows.max(1));
    let Some((cols, rows)) = session.size.lock().accept(want.0, want.1) else {
        return Ok(());
    };
    let master = session.master.lock();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // 关闭会话 = 节点删除（I2）。先摘节点再杀进程：读线程醒来时看到节点已不在，
    // 就不会把刚删掉的卷轴快照又写回来。
    {
        let mut workspace = state.workspace.lock();
        let _ = workspace.close_session(&id);
    }
    persist_workspace(&state);

    if let Some(session) = state.sessions.lock().remove(&id) {
        let _ = session.child.lock().kill();
    }
    // 关闭会话 = 节点删除：历史（M3）与卷轴快照一起销毁（I2）
    if let Some(history) = state.history() {
        history.delete_session(&id);
    }
    if let Some(dir) = state.data_dir.as_deref() {
        if let Err(err) = persistence::remove_scrollback(dir, &id) {
            eprintln!("[data] remove scrollback {id}: {err}");
        }
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
    // 解析失败不挡启动（本版没有必需落盘的状态），只把原因记到 stdout。
    let data_dir = persistence::data_dir();
    match &data_dir {
        Ok(dir) => println!("[data] {}", dir.display()),
        Err(err) => eprintln!("[data] {err}"),
    }
    let workspace = match data_dir.as_deref() {
        Ok(dir) => match persistence::load_workspace(dir) {
            persistence::WorkspaceLoad::Loaded(ws) => {
                println!(
                    "[data] workspace: {} window(s), {} session(s)",
                    ws.windows.len(),
                    ws.sessions.len()
                );
                ws
            }
            persistence::WorkspaceLoad::Recovered(ws) => {
                println!(
                    "[data] workspace recovered from .bak: {} session(s)",
                    ws.sessions.len()
                );
                ws
            }
            persistence::WorkspaceLoad::Missing => {
                println!("[data] workspace: first run");
                Workspace::new()
            }
            persistence::WorkspaceLoad::Unreadable(err) => {
                // 旧文件不会被覆盖丢失：下次写入时它会成为 .bak
                eprintln!("[data] workspace unreadable, starting empty: {err}");
                Workspace::new()
            }
        },
        Err(_) => Workspace::new(),
    };

    tauri::Builder::default()
        .manage(AppState::new(data_dir.ok(), workspace))
        .setup(|app| {
            // 历史库的单写线程要发 `history:append` 事件，所以等 AppHandle 就绪再建
            let state = app.state::<AppState>();
            let history = history::History::open(state.data_dir.as_deref(), app.handle().clone());
            println!("[data] history: {}", history.path().display());
            let _ = state.history.set(history);
            // WebView2 默认把 Ctrl+R / F5 当成浏览器的「刷新页面」：按键先到页面（前端看得见、
            // 也 preventDefault 得住），但 WebView2 照样执行刷新，结果是整页重载——窗口白闪一帧，
            // 会话得重新挂回。终端要保持页面常驻，所以把浏览器加速键全部关掉，按键只走 DOM。
            #[cfg(windows)]
            {
                use tauri::Manager;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows_core::Interface;
                if let Some(window) = app.get_webview_window("main") {
                    let applied = window.with_webview(|webview| unsafe {
                        let controller = webview.controller();
                        let Ok(core) = controller.CoreWebView2() else {
                            return;
                        };
                        let Ok(settings) = core.Settings() else { return };
                        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
                            return;
                        };
                        if settings3.SetAreBrowserAcceleratorKeysEnabled(false).is_ok() {
                            let mut on = windows_core::BOOL::default();
                            let _ = settings3.AreBrowserAcceleratorKeysEnabled(&mut on);
                            println!(
                                "[webview] 浏览器加速键: {}",
                                if on.as_bool() { "on（未生效）" } else { "off" }
                            );
                        }
                    });
                    if let Err(err) = applied {
                        eprintln!("[webview] 关浏览器加速键失败: {err}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            pty_write,
            pty_send_line,
            pty_set_override,
            pty_set_paused,
            pty_paused,
            pty_clear,
            pty_ownership,
            pty_history,
            history_snapshot,
            history_search,
            history_clear,
            pty_replay,
            pty_list,
            session_tree,
            rename_session,
            pty_resize,
            pty_close,
            bench_ping,
            bench_report
        ])
        // 退出应用 = 结束全部进程（I3）。屏幕内容先落成卷轴快照，下次启动接着还原；
        // 页面重载不是退出，会话要留着等前端挂回。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                let sessions: Vec<(String, Arc<Session>)> = state
                    .sessions
                    .lock()
                    .iter()
                    .map(|(id, session)| (id.clone(), session.clone()))
                    .collect();
                for (id, session) in &sessions {
                    save_session_scrollback(&state, session, id);
                }
                // 退出后没有任何进程还在跑：落盘就写冷，别让下次启动读到一堆 hot
                {
                    let mut workspace = state.workspace.lock();
                    for (id, _) in &sessions {
                        let _ = workspace.set_hot(id, false);
                    }
                }
                persist_workspace(&state);
                for (_, session) in sessions {
                    let _ = session.child.lock().kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PinShell");
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, powershell_encoded};

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    /// `-EncodedCommand` 的输入是 UTF-16LE 字节的 base64，不是 UTF-8。
    #[test]
    fn encoded_command_is_utf16le_base64() {
        assert_eq!(powershell_encoded("A"), "QQA=");
        assert_eq!(powershell_encoded("AB"), "QQBCAA==");
    }
}
