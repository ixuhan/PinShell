//! L1 集成测试的公共夹具：真 ConPTY + 真 shell，不开窗口。
//!
//! 每个用例自己拉起进程、自己回收；没有找到 shell 时由用例打印 skip，不伪装成通过。

#![allow(dead_code)]

use core_domain::osc::{OscEvent, OscParser};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

pub type Sink = dyn Write + Send;

pub struct Harness {
    writer: Box<Sink>,
    rx: Receiver<Vec<u8>>,
    parser: OscParser,
    child: Box<dyn Child + Send + Sync>,
    // 必须持有 master：一旦丢弃，ConPTY 句柄关闭，子进程立刻没有输出
    _master: Box<dyn MasterPty + Send>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

impl Harness {
    pub fn spawn(program: &str, args: &[&str]) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(cmd)
            .unwrap_or_else(|e| panic!("spawn {program}: {e}"));
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = pair.master.take_writer().expect("writer");
        let master = pair.master;
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        Self {
            writer,
            rx,
            parser: OscParser::new(),
            child,
            _master: master,
        }
    }

    pub fn send(&mut self, text: &str) {
        self.writer.write_all(text.as_bytes()).ok();
        self.writer.flush().ok();
    }

    /// 收集事件直到条件满足或超时。超时不算失败，由调用方断言看到什么。
    pub fn pump_until(&mut self, ms: u64, done: impl Fn(&[OscEvent]) -> bool) -> Vec<OscEvent> {
        let deadline = Instant::now() + Duration::from_millis(ms);
        let mut events = Vec::new();
        while Instant::now() < deadline {
            if done(&events) {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if let Ok(chunk) = self.rx.recv_timeout(left.min(Duration::from_millis(30))) {
                answer_queries(&chunk, &mut *self.writer);
                events.extend(self.parser.feed(&chunk));
            }
        }
        events
    }
}

/// shell 启动会先发 `ESC[6n` 查光标位置，不回答就停在原地（见 docs/research/04）。
fn answer_queries(bytes: &[u8], w: &mut Sink) {
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == 0x1b && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b';' || bytes[j] == b'?')
            {
                j += 1;
            }
            if j < bytes.len() {
                let params = &bytes[i + 2..j];
                match bytes[j] {
                    b'n' if params == b"6" => {
                        w.write_all(b"\x1b[1;1R").ok();
                    }
                    b'c' => {
                        w.write_all(b"\x1b[?1;2c").ok();
                    }
                    _ => {}
                }
                w.flush().ok();
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
}

pub fn has(events: &[OscEvent], want: &OscEvent) -> bool {
    events.iter().any(|e| e == want)
}

pub fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// 仓库里的集成脚本（`scripts/integration/<name>`）。
pub fn repo_script(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("scripts")
        .join("integration")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// 找 Git Bash。PATH 上的 `bash.exe` 通常是 WSL 启动器，语义不同，先跳过。
pub fn find_bash() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(root) = std::env::var_os("GIT_INSTALL_ROOT") {
        candidates.push(PathBuf::from(root).join("bin").join("bash.exe"));
    }
    candidates.push(PathBuf::from(r"D:\Git\bin\bash.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"));
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"));
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let lower = dir.to_string_lossy().to_ascii_lowercase();
            if lower.contains("windowsapps") {
                continue;
            }
            candidates.push(dir.join("bash.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}
