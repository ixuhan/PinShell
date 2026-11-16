//! L1 集成测试：用真实 pwsh + ConPTY 验证集成脚本与 OSC 解析器。
//!
//! 不开窗口、不依赖 Tauri、不碰主工程的 target 目录。
//! 机器上没有 pwsh 时跳过（打印 skip），不伪装成通过。

mod support;

use core_domain::osc::OscEvent;
use support::{has, on_path, repo_script, Harness};

#[test]
fn pwsh_reports_prompt_and_command_boundaries() {
    if !on_path("pwsh.exe") {
        eprintln!("skip: pwsh.exe not on PATH");
        return;
    }

    let script = repo_script("pinshell.ps1");
    let command = format!(". '{script}'");
    let mut h = Harness::spawn(
        "pwsh.exe",
        &["-NoLogo", "-NoExit", "-Command", command.as_str()],
    );

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

    let script = repo_script("pinshell.ps1");
    let command = format!(". '{script}'");
    let mut h = Harness::spawn(
        "pwsh.exe",
        &["-NoLogo", "-NoExit", "-Command", command.as_str()],
    );
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
