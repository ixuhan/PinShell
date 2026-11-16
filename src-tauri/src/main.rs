#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use core_domain::osc::{OscEvent, OscParser};
use core_domain::utf8_stream::Utf8Stream;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// 一个会话的运行时句柄。输入所有权、状态机等后续模块都挂在这里。
struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Clone, Serialize)]
struct OutPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
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

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn resolve_shell(preferred: Option<String>) -> String {
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
    let session = Arc::new(Session {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });
    state.sessions.lock().insert(id.clone(), session);

    // 每个会话一个读线程（ConPTY 要求读写分离，否则死锁）
    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut stream = Utf8Stream::new();
        let mut parser = OscParser::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 先推进标记，再发字节：状态变化不晚于屏幕变化
                    for ev in parser.feed(&buf[..n]) {
                        if let Some(marker) = marker_of(ev) {
                            let _ = app.emit(
                                "pty:marker",
                                MarkerEvent {
                                    id: emit_id.clone(),
                                    marker,
                                },
                            );
                        }
                    }
                    let text = stream.push(&buf[..n]);
                    if !text.is_empty() {
                        let _ = app.emit(
                            "pty:out",
                            OutPayload {
                                id: emit_id.clone(),
                                data: text,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit("pty:exit", ExitPayload { id: emit_id });
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("write: {e}"))
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
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            pty_write,
            pty_resize,
            pty_close,
            bench_ping,
            bench_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running PinShell");
}
