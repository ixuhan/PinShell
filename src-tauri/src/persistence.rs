//! 数据目录与原子落盘。M2 的第一块持久化。
//!
//! 目录选择（顺序固定，不猜）：
//! 1. `PINSHELL_DATA_DIR`（测试与高级用户；明确指定却不可写 → 报错，不悄悄回退）
//! 2. exe 同级的 `data\`（便携）
//! 3. `%APPDATA%\PinShell\`
//!
//! 写入：同目录 tmp → `sync_all`（FlushFileBuffers）→ 旧版挪成 `.bak` → tmp 改名覆盖。
//! Windows 没有目录 fsync，不照搬 POSIX；任何一步失败都不会留下半截主文件。
//!
//! 读取：主文件坏了退 `.bak`；两个都坏返回 `Unreadable`，由调用方决定是否重置。

use core_domain::ownership::TransportKind;
use core_domain::workspace::{Axis, Layout, Rect, SessionMeta, Window, Workspace};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

pub const WORKSPACE_FILE: &str = "workspace.json";

/// `workspace.json` 的结构版本。读到更高版本时拒绝，免得把旧程序不认识的数据写回去。
pub const WORKSPACE_VERSION: u32 = 1;

/// 解析出的数据目录。
pub fn data_dir() -> Result<PathBuf, String> {
    let explicit = std::env::var_os("PINSHELL_DATA_DIR").map(PathBuf::from);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    resolve_data_dir(explicit, &exe_dir, appdata.as_deref())
}

/// 目录选择的纯规则，输入全部显式传入，方便测试。
pub fn resolve_data_dir(
    explicit: Option<PathBuf>,
    exe_dir: &Path,
    appdata: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(dir) = explicit.filter(|d| !d.as_os_str().is_empty()) {
        return ensure_writable(&dir)
            .map(|_| dir.clone())
            .map_err(|e| format!("PINSHELL_DATA_DIR {}: {e}", dir.display()));
    }
    let portable = exe_dir.join("data");
    if ensure_writable(&portable).is_ok() {
        return Ok(portable);
    }
    if let Some(app) = appdata {
        let dir = app.join("PinShell");
        if ensure_writable(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err(format!(
        "no writable data dir (tried {} and %APPDATA%\\PinShell)",
        portable.display()
    ))
}

fn ensure_writable(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let probe = dir.join(".write-probe");
    {
        let mut file = File::create(&probe)?;
        file.write_all(b"1")?;
    }
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// 读文件的结果。`Backup` 表示主文件坏了、从 `.bak` 救回来的。
#[derive(Debug, PartialEq)]
pub enum Load<T> {
    Primary(T),
    Backup(T),
    Missing,
    Unreadable(String),
}

pub fn read_with_backup<T: DeserializeOwned>(path: &Path) -> Load<T> {
    let mut errors = Vec::new();
    for (candidate, primary) in [(path.to_path_buf(), true), (sibling(path, ".bak"), false)] {
        let bytes = match fs::read(&candidate) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                errors.push(format!("{}: {err}", candidate.display()));
                continue;
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(value) if primary => return Load::Primary(value),
            Ok(value) => return Load::Backup(value),
            Err(err) => errors.push(format!("{}: {err}", candidate.display())),
        }
    }
    if errors.is_empty() {
        Load::Missing
    } else {
        Load::Unreadable(errors.join("; "))
    }
}

/// 原子写：失败时保留原主文件，tmp 一定清理掉。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(dir)?;

    let tmp = sibling(path, ".tmp");
    let result = (|| -> io::Result<()> {
        {
            let mut file = File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        if path.exists() {
            let bak = sibling(path, ".bak");
            if bak.exists() {
                fs::remove_file(&bak)?;
            }
            fs::rename(path, &bak)?;
        }
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

// ---------- 卷轴快照：每个会话一个文件，只用于显示 ----------

pub const SCROLLBACK_DIR: &str = "scrollback";
pub const SCROLLBACK_EXT: &str = "ansi";

/// 会话 id → 文件名。id 来自前端（`spawn_session` 的 `session_id`），
/// 必须挡住 `..`、路径分隔符与空名，否则一个 id 就能写到数据目录外面去。
/// 合法 id（UUID 之类）原样使用，读起来方便；不合法的一律换成定长哈希名。
pub fn session_file_name(id: &str) -> String {
    let safe = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if safe {
        return format!("{id}.{SCROLLBACK_EXT}");
    }
    // FNV-1a：只需要稳定与分散，不用于安全
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("h-{hash:016x}.{SCROLLBACK_EXT}")
}

pub fn scrollback_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(SCROLLBACK_DIR).join(session_file_name(id))
}

/// 覆盖写：tmp → flush → 旧版挪到 `.old` → tmp 改名就位 → 删掉 `.old`。
/// 不保留 `.bak`：卷轴快照只是显示层，旧版没有长期救回价值。
/// 但不能「先删旧版再改名」——改名失败时旧内容会一起丢；中间状态至少有完整的一份。
fn write_replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(dir)?;

    let tmp = sibling(path, ".tmp");
    let previous = sibling(path, ".old");
    let result = (|| -> io::Result<()> {
        {
            let mut file = File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        // 上次恰好在两步之间崩了：主文件不在、只剩 `.old`，先把它放回去
        if !path.exists() && previous.exists() {
            fs::rename(&previous, path)?;
        }
        // Windows 的 rename 不覆盖已存在的目标
        if path.exists() {
            if previous.exists() {
                fs::remove_file(&previous)?;
            }
            fs::rename(path, &previous)?;
        }
        match fs::rename(&tmp, path) {
            Ok(()) => {
                let _ = fs::remove_file(&previous);
                Ok(())
            }
            Err(err) => {
                // 新文件没就位：把旧版挪回去，至少屏幕还能还原到上一次
                let _ = fs::rename(&previous, path);
                Err(err)
            }
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 落一份卷轴快照。空内容不写：没有画面就没有可还原的东西。
pub fn save_scrollback(dir: &Path, id: &str, text: &str) -> io::Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    write_replace(&scrollback_path(dir, id), text.as_bytes())
}

/// 读回卷轴快照。文件不存在、读不动或内容不是合法 UTF-8 都返回 `None`：
/// 丢一段历史屏幕可以接受，为此让会话起不来不行。
pub fn load_scrollback(dir: &Path, id: &str) -> Option<String> {
    let bytes = fs::read(scrollback_path(dir, id)).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// 删除卷轴快照（关闭会话 = 节点删除，见 I2）。
pub fn remove_scrollback(dir: &Path, id: &str) -> io::Result<()> {
    match fs::remove_file(scrollback_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

// ---------- 工作区 JSON：DTO 与 core-domain 模型互转（core-domain 保持零依赖） ----------

#[derive(Debug, Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    windows: Vec<WindowFile>,
    sessions: Vec<SessionFile>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WindowFile {
    id: u64,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    layout: LayoutFile,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LayoutFile {
    Leaf {
        session: String,
    },
    Split {
        axis: AxisFile,
        ratio: f32,
        first: Box<LayoutFile>,
        second: Box<LayoutFile>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AxisFile {
    Horizontal,
    Vertical,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    id: String,
    title: String,
    transport: TransportFile,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
    #[serde(default)]
    hot: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransportFile {
    Terminal,
    Serial,
}

impl From<TransportKind> for TransportFile {
    fn from(kind: TransportKind) -> Self {
        match kind {
            TransportKind::Terminal => TransportFile::Terminal,
            TransportKind::Serial => TransportFile::Serial,
        }
    }
}

impl From<TransportFile> for TransportKind {
    fn from(file: TransportFile) -> Self {
        match file {
            TransportFile::Terminal => TransportKind::Terminal,
            TransportFile::Serial => TransportKind::Serial,
        }
    }
}

pub enum WorkspaceLoad {
    /// 主文件读到的
    Loaded(Workspace),
    /// 主文件坏了，从备份救回的
    Recovered(Workspace),
    /// 首次运行
    Missing,
    /// 两个副本都不可用（含结构非法）
    Unreadable(String),
}

pub fn load_workspace(dir: &Path) -> WorkspaceLoad {
    match read_with_backup::<WorkspaceFile>(&dir.join(WORKSPACE_FILE)) {
        Load::Missing => WorkspaceLoad::Missing,
        Load::Unreadable(err) => WorkspaceLoad::Unreadable(err),
        Load::Primary(file) => match workspace_from_file(file) {
            Ok(workspace) => WorkspaceLoad::Loaded(workspace),
            Err(err) => WorkspaceLoad::Unreadable(err),
        },
        Load::Backup(file) => match workspace_from_file(file) {
            Ok(workspace) => WorkspaceLoad::Recovered(workspace),
            Err(err) => WorkspaceLoad::Unreadable(err),
        },
    }
}

pub fn save_workspace(dir: &Path, workspace: &Workspace) -> io::Result<()> {
    let file = workspace_to_file(workspace);
    let json = serde_json::to_vec_pretty(&file)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    write_atomic(&dir.join(WORKSPACE_FILE), &json)
}

fn workspace_to_file(workspace: &Workspace) -> WorkspaceFile {
    WorkspaceFile {
        version: WORKSPACE_VERSION,
        windows: workspace
            .windows
            .iter()
            .map(|window| WindowFile {
                id: window.id,
                x: window.rect.x,
                y: window.rect.y,
                width: window.rect.width,
                height: window.rect.height,
                layout: layout_to_file(&window.layout),
            })
            .collect(),
        sessions: workspace
            .sessions
            .iter()
            .map(|session| SessionFile {
                id: session.id.clone(),
                title: session.title.clone(),
                transport: session.transport.into(),
                cwd: session.cwd.clone(),
                shell: session.shell.clone(),
                hot: session.hot,
            })
            .collect(),
    }
}

fn layout_to_file(layout: &Layout) -> LayoutFile {
    match layout {
        Layout::Leaf { session } => LayoutFile::Leaf {
            session: session.clone(),
        },
        Layout::Split {
            axis,
            ratio,
            first,
            second,
        } => LayoutFile::Split {
            axis: match axis {
                Axis::Horizontal => AxisFile::Horizontal,
                Axis::Vertical => AxisFile::Vertical,
            },
            ratio: *ratio,
            first: Box::new(layout_to_file(first)),
            second: Box::new(layout_to_file(second)),
        },
    }
}

/// 落盘后一律按冷会话读回：热是进程的事，重启后由启动流程逐个拉起。
fn workspace_from_file(file: WorkspaceFile) -> Result<Workspace, String> {
    if file.version > WORKSPACE_VERSION {
        return Err(format!(
            "workspace version {} is newer than {}",
            file.version, WORKSPACE_VERSION
        ));
    }
    let workspace = Workspace {
        windows: file
            .windows
            .iter()
            .map(|window| Window {
                id: window.id,
                rect: Rect::new(window.x, window.y, window.width, window.height),
                layout: layout_from_file(&window.layout),
            })
            .collect(),
        sessions: file
            .sessions
            .iter()
            .map(|session| SessionMeta {
                id: session.id.clone(),
                title: session.title.clone(),
                transport: session.transport.into(),
                cwd: session.cwd.clone(),
                shell: session.shell.clone(),
                hot: false,
            })
            .collect(),
    };
    workspace
        .validate()
        .map_err(|err| format!("invalid workspace: {err:?}"))?;
    Ok(workspace)
}

fn layout_from_file(layout: &LayoutFile) -> Layout {
    match layout {
        LayoutFile::Leaf { session } => Layout::leaf(session.clone()),
        LayoutFile::Split {
            axis,
            ratio,
            first,
            second,
        } => Layout::Split {
            axis: match axis {
                AxisFile::Horizontal => Axis::Horizontal,
                AxisFile::Vertical => Axis::Vertical,
            },
            ratio: *ratio,
            first: Box::new(layout_from_file(first)),
            second: Box::new(layout_from_file(second)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "pinshell-test-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn sample_workspace() -> Workspace {
        let mut ws = Workspace::new();
        ws.add_session(SessionMeta::terminal("s1", "pwsh", "pwsh.exe"))
            .unwrap();
        ws.add_session(SessionMeta::terminal("s2", "bash", "bash.exe"))
            .unwrap();
        ws.open("s1", Rect::new(10.0, 20.0, 1200.0, 800.0)).unwrap();
        ws.split("s1", "s2", Axis::Horizontal, 0.4).unwrap();
        ws
    }

    #[test]
    fn workspace_round_trips_through_disk() {
        let dir = temp_dir("roundtrip");
        let ws = sample_workspace();
        save_workspace(&dir, &ws).unwrap();

        let loaded = load_workspace(&dir);
        match loaded {
            WorkspaceLoad::Loaded(back) => assert_eq!(back, ws),
            other => panic!("expected Loaded, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn loaded_sessions_are_cold() {
        let dir = temp_dir("cold");
        let mut ws = sample_workspace();
        ws.set_hot("s1", true).unwrap();
        save_workspace(&dir, &ws).unwrap();
        match load_workspace(&dir) {
            WorkspaceLoad::Loaded(back) => {
                assert!(back.sessions.iter().all(|s| !s.hot));
            }
            other => panic!("expected Loaded, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_write_keeps_the_previous_version_as_bak() {
        let dir = temp_dir("bak");
        let mut ws = sample_workspace();
        save_workspace(&dir, &ws).unwrap();

        ws.close_session("s2").unwrap();
        save_workspace(&dir, &ws).unwrap();

        let bak = fs::read_to_string(dir.join("workspace.json.bak")).unwrap();
        let old: WorkspaceFile = serde_json::from_str(&bak).unwrap();
        assert_eq!(old.sessions.len(), 2);

        match load_workspace(&dir) {
            WorkspaceLoad::Loaded(back) => assert_eq!(back, ws),
            other => panic!("expected Loaded, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_primary_falls_back_to_backup() {
        let dir = temp_dir("recover");
        let ws = sample_workspace();
        save_workspace(&dir, &ws).unwrap();
        save_workspace(&dir, &ws).unwrap(); // 让 .bak 存在
        fs::write(dir.join(WORKSPACE_FILE), b"{ not json").unwrap();

        match load_workspace(&dir) {
            WorkspaceLoad::Recovered(back) => assert_eq!(back, ws),
            other => panic!("expected Recovered, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_copies_corrupt_is_reported_not_silently_reset() {
        let dir = temp_dir("bothbad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(WORKSPACE_FILE), b"nope").unwrap();
        fs::write(dir.join("workspace.json.bak"), b"nope").unwrap();

        match load_workspace(&dir) {
            WorkspaceLoad::Unreadable(err) => assert!(err.contains("workspace.json")),
            other => panic!("expected Unreadable, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_workspace_means_first_run() {
        let dir = temp_dir("missing");
        assert!(matches!(load_workspace(&dir), WorkspaceLoad::Missing));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn structurally_invalid_workspace_is_rejected() {
        let dir = temp_dir("invalid");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(WORKSPACE_FILE),
            br#"{
              "version": 1,
              "windows": [{"id": 1, "x": 0, "y": 0, "width": 800, "height": 600,
                           "layout": {"kind": "leaf", "session": "ghost"}}],
              "sessions": []
            }"#,
        )
        .unwrap();
        match load_workspace(&dir) {
            WorkspaceLoad::Unreadable(err) => assert!(err.contains("ghost")),
            other => panic!("expected Unreadable, got {:?}", describe(&other)),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_data_dir_wins_when_writable() {
        let dir = temp_dir("explicit");
        let resolved = resolve_data_dir(Some(dir.clone()), Path::new("C:\\nope"), None).unwrap();
        assert_eq!(resolved, dir);
        assert!(dir.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_data_dir_is_preferred_over_appdata() {
        let dir = temp_dir("portable");
        let exe_dir = dir.join("app");
        fs::create_dir_all(&exe_dir).unwrap();
        let appdata = dir.join("roaming");

        let resolved = resolve_data_dir(None, &exe_dir, Some(&appdata)).unwrap();
        assert_eq!(resolved, exe_dir.join("data"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unwritable_portable_dir_falls_back_to_appdata() {
        let dir = temp_dir("fallback");
        fs::create_dir_all(&dir).unwrap();
        // 让「exe 同级 data」无法创建：把 exe 目录做成一个普通文件
        let exe_dir = dir.join("blocked");
        fs::write(&exe_dir, b"x").unwrap();
        let appdata = dir.join("roaming");

        let resolved = resolve_data_dir(None, &exe_dir, Some(&appdata)).unwrap();
        assert_eq!(resolved, appdata.join("PinShell"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_unwritable_dir_errors_instead_of_falling_back() {
        let dir = temp_dir("explicitbad");
        fs::create_dir_all(&dir).unwrap();
        let blocked = dir.join("blocked");
        fs::write(&blocked, b"x").unwrap();

        let err = resolve_data_dir(Some(blocked.join("data")), &dir, Some(&dir)).unwrap_err();
        assert!(err.contains("PINSHELL_DATA_DIR"));
        let _ = fs::remove_dir_all(&dir);
    }

    fn describe(load: &WorkspaceLoad) -> String {
        match load {
            WorkspaceLoad::Loaded(_) => "Loaded".into(),
            WorkspaceLoad::Recovered(_) => "Recovered".into(),
            WorkspaceLoad::Missing => "Missing".into(),
            WorkspaceLoad::Unreadable(err) => format!("Unreadable({err})"),
        }
    }

    #[test]
    fn scrollback_round_trips_and_removes() {
        let dir = temp_dir("scrollback");
        let text = "PS C:\\> ls\r\n\x1b[32mgreen\x1b[0m\r\n";
        save_scrollback(&dir, "s1", text).unwrap();
        assert_eq!(load_scrollback(&dir, "s1").as_deref(), Some(text));

        remove_scrollback(&dir, "s1").unwrap();
        assert_eq!(load_scrollback(&dir, "s1"), None);
        // 再删一次不算错：关闭会话可能被重复触发
        remove_scrollback(&dir, "s1").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_scrollback_is_not_written() {
        let dir = temp_dir("scrollbackempty");
        save_scrollback(&dir, "s1", "").unwrap();
        assert_eq!(load_scrollback(&dir, "s1"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwriting_a_snapshot_keeps_only_the_new_one() {
        let dir = temp_dir("scrollbackover");
        save_scrollback(&dir, "s1", "first").unwrap();
        save_scrollback(&dir, "s1", "second").unwrap();
        assert_eq!(load_scrollback(&dir, "s1").as_deref(), Some("second"));
        // 不保留 .bak：显示层不需要上一版
        assert!(!dir.join(SCROLLBACK_DIR).join("s1.ansi.bak").exists());
        assert!(!dir.join(SCROLLBACK_DIR).join("s1.ansi.tmp").exists());
        // 中间那份 .old 也只是过渡，成功替换后必须清掉
        assert!(!dir.join(SCROLLBACK_DIR).join("s1.ansi.old").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_old_snapshot_is_recovered_on_the_next_write() {
        // 上次在「旧版挪到 .old」与「新文件就位」之间崩了：主文件不在，.old 还在
        let dir = temp_dir("scrollbackstale");
        let path = scrollback_path(&dir, "s1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(sibling(&path, ".old"), "previous").unwrap();

        save_scrollback(&dir, "s1", "next").unwrap();
        assert_eq!(load_scrollback(&dir, "s1").as_deref(), Some("next"));
        assert!(!sibling(&path, ".old").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostname_ids_stay_inside_the_scrollback_dir() {
        let dir = temp_dir("scrollbackpath");
        let base = dir.join(SCROLLBACK_DIR);
        for id in [
            "..",
            ".",
            "",
            "../../evil",
            "a/b",
            "a\\b",
            "C:evil",
            "con",
            "with space",
        ] {
            let path = scrollback_path(&dir, id);
            assert_eq!(path.parent(), Some(base.as_path()), "id={id:?}");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.ends_with(".ansi"), "id={id:?} name={name}");
            assert!(!name.contains('/') && !name.contains('\\'), "id={id:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_names_are_stable_and_distinct() {
        assert_eq!(session_file_name("s1"), "s1.ansi");
        assert_ne!(session_file_name("a/b"), session_file_name("a\\b"));
        assert_ne!(session_file_name(""), session_file_name("."));
        let long = "x".repeat(200);
        assert!(session_file_name(&long).len() <= 64);
        assert_eq!(session_file_name(&long), session_file_name(&long));
    }
}
