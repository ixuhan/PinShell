//! L1 集成测试：用真实 pwsh + ConPTY 验证集成脚本与 OSC 解析器。
//!
//! 不开窗口、不依赖 Tauri、不碰主工程的 target 目录。
//! 机器上没有 pwsh 时跳过（打印 skip），不伪装成通过。

use core_domain::osc::{OscEvent, OscParser};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

type Sink = dyn Write + Send;

struct Harness {
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
    fn spawn(script: &str) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("pwsh.exe");
        cmd.args(["-NoLogo", "-NoExit", "-Command", &format!(". '{script}'")]);
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).expect("spawn pwsh");
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

    fn send(&mut self, text: &str) {
        self.writer.write_all(text.as_bytes()).ok();
        self.writer.flush().ok();
    }

    /// 收集事件直到超时。
    fn pump_until(&mut self, ms: u64, done: impl Fn(&[OscEvent]) -> bool) -> Vec<OscEvent> {
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

/// pwsh 启动会先发 `ESC[6n` 查光标位置，不回答就停在原地（见 docs/research/04）。
fn answer_queries(bytes: &[u8], w: &mut Sink) {
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == 0x1b && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            while j < bytes.len()
                && (bytes[j].is_ascii_digit() || bytes[j] == b';' || bytes[j] == b'?')
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

fn has(events: &[OscEvent], want: &OscEvent) -> bool {
    events.iter().any(|e| e == want)
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn script_path() -> String {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/integration/pinshell.ps1"
    )
    .to_string()
}

#[test]
fn pwsh_reports_prompt_and_command_boundaries() {
    if !on_path("pwsh.exe") {
        eprintln!("skip: pwsh.exe not on PATH");
        return;
    }

    let mut h = Harness::spawn(&script_path());

    let boot = h.pump_until(6000, |e| {
        has(e, &OscEvent::PromptStart) && e.iter().any(|x| matches!(x, OscEvent::Cwd(_)))
    });
    assert!(
        has(&boot, &OscEvent::PromptStart),
        "首个提示符没有上报 A：{boot:?}"
    );
    assert!(
        boot.iter().any(|e| matches!(e, OscEvent::Cwd(_))),
        "没有上报 CWD：{boot:?}"
    );
    assert!(
        !boot.iter().any(|e| matches!(e, OscEvent::CommandEnd { .. })),
        "启动时不该有 D：{boot:?}"
    );

    h.send("echo hi\r");
    let echo = h.pump_until(3000, |e| {
        has(e, &OscEvent::CommandEnd { code: Some(0) }) && has(e, &OscEvent::PromptStart)
    });
    assert!(has(&echo, &OscEvent::CommandStart), "缺少 C：{echo:?}");
    assert!(
        has(&echo, &OscEvent::CommandEnd { code: Some(0) }),
        "成功命令应给 D;0：{echo:?}"
    );
    assert!(
        has(&echo, &OscEvent::PromptStart),
        "命令结束后没有重新上报提示符：{echo:?}"
    );

    h.send("cmd /c exit 7\r");
    let failed = h.pump_until(4000, |e| {
        has(e, &OscEvent::CommandEnd { code: Some(7) })
    });
    assert!(
        has(&failed, &OscEvent::CommandEnd { code: Some(7) }),
        "原生命令退出码没有透传：{failed:?}"
    );

    // 失败之后成功的命令必须回到 0，不能沿用陈旧的 7
    h.send("echo ok\r");
    let recovered = h.pump_until(3000, |e| {
        has(e, &OscEvent::CommandEnd { code: Some(0) })
    });
    assert!(
        has(&recovered, &OscEvent::CommandEnd { code: Some(0) }),
        "退出码回收错误：{recovered:?}"
    );
}

#[test]
fn cwd_change_is_reported() {
    if !on_path("pwsh.exe") {
        eprintln!("skip: pwsh.exe not on PATH");
        return;
    }

    let mut h = Harness::spawn(&script_path());
    h.pump_until(6000, |e| has(e, &OscEvent::PromptStart));

    h.send("cd 'C:\\Program Files'\r");
    let ev = h.pump_until(4000, |e| {
        e.iter()
            .any(|x| matches!(x, OscEvent::Cwd(p) if p == "C:/Program Files"))
    });
    assert!(
        ev.iter()
            .any(|e| matches!(e, OscEvent::Cwd(p) if p == "C:/Program Files")),
        "cd 之后 CWD 没更新（或百分号没有解码）：{ev:?}"
    );
}
