use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub(super) struct TerminalProfile {
    id: &'static str,
    title: &'static str,
    command: String,
}

fn find_on_path(names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(path) = std::env::var_os("PATH").and_then(|value| {
            std::env::split_paths(&value)
                .map(|dir| dir.join(name))
                .find(|path| path.is_file())
        }) {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

#[tauri::command]
pub(super) fn terminal_profiles() -> Vec<TerminalProfile> {
    let mut profiles = Vec::new();
    if let Some(command) = find_on_path(&["pwsh.exe", "pwsh"]) {
        profiles.push(TerminalProfile {
            id: "pwsh",
            title: "PowerShell 7",
            command,
        });
    }
    if let Some(command) = find_on_path(&["powershell.exe", "powershell"]) {
        profiles.push(TerminalProfile {
            id: "powershell",
            title: "Windows PowerShell",
            command,
        });
    }
    profiles.push(TerminalProfile {
        id: "cmd",
        title: "命令提示符",
        command: std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
    });

    let mut bash = find_on_path(&["bash.exe", "bash"]);
    #[cfg(windows)]
    if bash.is_none() {
        let roots = [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("LOCALAPPDATA"),
        ];
        for root in roots.into_iter().flatten() {
            for suffix in ["Git\\bin\\bash.exe", "Programs\\Git\\bin\\bash.exe"] {
                let candidate = PathBuf::from(&root).join(suffix);
                if candidate.is_file() {
                    bash = Some(candidate.to_string_lossy().into_owned());
                    break;
                }
            }
            if bash.is_some() {
                break;
            }
        }
    }
    if let Some(command) = bash {
        profiles.push(TerminalProfile {
            id: "git-bash",
            title: "Git Bash",
            command,
        });
    }
    profiles
}
