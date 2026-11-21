//! 文件面板的原生右键菜单：调用同目录的 helper 进程，失败就告诉前端降级。
//!
//! 这里只做三件事：找到 helper、给它一个窗口句柄与路径、把结果翻译成三态。
//! 菜单内容与命令执行都在 helper 里（`src/bin/shellmenu.rs`），主进程不碰 COM，
//! 所以第三方 shell 扩展崩溃时主进程连一次栈都没展开。

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// helper 与主程序放在同一个目录（开发期是 `target/debug`，打包后是安装目录）。
const HELPER_NAME: &str = "pinshell-shellmenu.exe";

/// 用户可能开着菜单慢慢看，所以上限给得宽。超过就杀掉并降级，绝不让主线程等死。
const MAX_WAIT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(40);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 用户选了某一项，helper 已经执行（打开、复制、7-Zip……）
    Handled,
    /// 菜单弹出来了，用户点了外面或按了 Esc
    Cancelled,
    /// helper 不在、起不来或半路死了：前端改用自建菜单
    Unavailable,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Handled => "handled",
            Outcome::Cancelled => "cancelled",
            Outcome::Unavailable => "unavailable",
        }
    }
}

/// 找 helper：`PINSHELL_SHELLMENU`（测试与排障用）优先，其次主程序同目录。
pub fn helper_path() -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os("PINSHELL_SHELLMENU") {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir.join(HELPER_NAME);
    if candidate.is_file() {
        return Some(candidate);
    }
    // 早期构建叫 shellmenu.exe，留着这条回退免得旧目录里找不到
    let legacy = dir.join("shellmenu.exe");
    legacy.is_file().then_some(legacy)
}

/// 弹菜单并等用户选完。返回 `Unavailable` 时前端应当自己画菜单。
pub fn run(path: &str, hwnd: usize, background: bool) -> Outcome {
    run_with(helper_path(), path, hwnd, background)
}

/// 指定 helper 的版本。测试用它注入「没有 helper / 不是可执行文件」这两种情况，
/// 不必去改 `PINSHELL_SHELLMENU`——那是进程级状态，并行跑的测试会互相踩。
fn run_with(helper: Option<PathBuf>, path: &str, hwnd: usize, background: bool) -> Outcome {
    let Some(helper) = helper else {
        return Outcome::Unavailable;
    };
    let mut command = Command::new(&helper);
    command
        .arg("--path")
        .arg(path)
        .arg("--hwnd")
        .arg(hwnd.to_string());
    if background {
        command.arg("--background");
    }
    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            eprintln!("[menu] helper 起不来: {err}");
            return Outcome::Unavailable;
        }
    };

    // 把「切前台」的资格授予 helper：它要用自己的窗口当菜单 owner，而菜单 owner
    // 不在前台时点外面菜单不会消失。只有前台进程能授予这个权限（右键时正是我们），
    // 授不成功也不影响菜单弹出。
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
        let _ = AllowSetForegroundWindow(child.id());
    }

    let deadline = Instant::now() + MAX_WAIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut line = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut line);
                }
                if !status.success() {
                    eprintln!("[menu] helper 退出码 {:?}", status.code());
                    return Outcome::Unavailable;
                }
                return match line.trim() {
                    "handled" => Outcome::Handled,
                    "cancelled" => Outcome::Cancelled,
                    other => {
                        eprintln!("[menu] helper 回了看不懂的结果: {other:?}");
                        Outcome::Unavailable
                    }
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    eprintln!("[menu] helper 超时，按不可用处理");
                    let _ = child.kill();
                    let _ = child.wait();
                    return Outcome::Unavailable;
                }
                std::thread::sleep(POLL);
            }
            Err(err) => {
                eprintln!("[menu] 等 helper 失败: {err}");
                let _ = child.kill();
                return Outcome::Unavailable;
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn outcomes_have_stable_wire_names() {
        assert_eq!(Outcome::Handled.as_str(), "handled");
        assert_eq!(Outcome::Cancelled.as_str(), "cancelled");
        assert_eq!(Outcome::Unavailable.as_str(), "unavailable");
    }

    /// 右键永远得有反应：没有 helper 时返回 `Unavailable`，前端才知道要画自建菜单。
    #[test]
    fn no_helper_anywhere_degrades() {
        assert_eq!(run_with(None, "C:\\", 0, false), Outcome::Unavailable);
        assert_eq!(run_with(None, "C:\\", 0, true), Outcome::Unavailable);
    }

    /// helper 被删了、路径写错了，都走降级，不 panic、不弹错误框。
    #[test]
    fn a_missing_helper_degrades() {
        let missing = std::env::temp_dir().join("pinshell-no-such-helper.exe");
        assert_eq!(run_with(Some(missing.clone()), "C:\\", 0, false), Outcome::Unavailable);
        assert_eq!(run_with(Some(missing), "C:\\", 0, true), Outcome::Unavailable);
    }

    /// 路径存在但不是可执行映像（杀软隔离后留下的占位、拷了一半的文件）：
    /// spawn 失败也必须降级，而不是让 `fs_context_menu` 抛错。
    #[test]
    fn a_helper_that_cannot_start_degrades() {
        let dir = std::env::temp_dir().join(format!("pinshell-helper-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let fake = dir.join("pinshell-shellmenu.exe");
        std::fs::write(&fake, b"not a PE image").expect("write fake helper");
        assert_eq!(run_with(Some(fake), "C:\\", 0, false), Outcome::Unavailable);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
