//! L1 集成测试：用真 bash + ConPTY 验证 bash 版集成脚本。
//!
//! 优先用 Git Bash（PATH 上的 bash.exe 往往是 WSL 启动器，语义不同）。
//! 找不到就打印 skip，不伪装成通过。

mod support;

use core_domain::osc::OscEvent;
use support::{find_bash, has, repo_script, Harness};

fn spawn_bash() -> Option<Harness> {
    let bash = find_bash()?;
    let script = repo_script("pinshell.bash");
    Some(Harness::spawn(
        &bash,
        &["--init-file", script.as_str(), "-i"],
    ))
}

#[test]
fn bash_reports_prompt_and_command_boundaries() {
    let Some(mut h) = spawn_bash() else {
        eprintln!("skip: bash not found");
        return;
    };

    let boot = h.pump_until(8000, |e| {
        has(e, &OscEvent::PromptStart) && e.iter().any(|x| matches!(x, OscEvent::Cwd(_)))
    });
    assert!(
        has(&boot, &OscEvent::PromptStart),
        "首个提示符没有上报 A：{boot:?}"
    );
    let boot_cwd = boot
        .iter()
        .find_map(|e| match e {
            OscEvent::Cwd(p) => Some(p.clone()),
            _ => None,
        })
        .expect("没有上报 CWD");

    h.send("echo hi\r");
    let echo = h.pump_until(4000, |e| {
        has(e, &OscEvent::CommandEnd { code: Some(0) }) && has(e, &OscEvent::PromptStart)
    });
    assert!(has(&echo, &OscEvent::CommandStart), "缺少 C（PS0 没生效？）：{echo:?}");
    assert!(
        has(&echo, &OscEvent::CommandEnd { code: Some(0) }),
        "成功命令应给 D;0：{echo:?}"
    );
    assert!(
        has(&echo, &OscEvent::PromptStart),
        "命令结束后没有重新上报提示符：{echo:?}"
    );

    // 失败命令的退出码必须原样上报
    h.send("false\r");
    let failed = h.pump_until(4000, |e| {
        has(e, &OscEvent::CommandEnd { code: Some(1) })
    });
    assert!(
        has(&failed, &OscEvent::CommandEnd { code: Some(1) }),
        "退出码没有透传：{failed:?}"
    );

    // 切目录之后 CWD 必须更新，且已经换成 Windows 路径（cygpath -m）
    h.send("cd /tmp\r");
    let cwd = h.pump_until(4000, |e| {
        e.iter()
            .any(|x| matches!(x, OscEvent::Cwd(p) if *p != boot_cwd))
    });
    let moved = cwd.iter().find_map(|e| match e {
        OscEvent::Cwd(p) if *p != boot_cwd => Some(p.clone()),
        _ => None,
    });
    let moved = moved.unwrap_or_else(|| panic!("cd 之后 CWD 没更新：{cwd:?}"));
    assert!(
        moved.starts_with('/') || moved.as_bytes().get(1) == Some(&b':'),
        "CWD 不是绝对路径：{moved}"
    );
}
