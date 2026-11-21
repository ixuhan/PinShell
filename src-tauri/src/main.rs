#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use core_domain::coalesce::Coalescer;
use core_domain::osc::{OscEvent, OscParser};
use core_domain::ownership::{
    decide, is_submit, Confidence, Override, Owner, PromptTracker, TerminalState, TransportKind,
};
use core_domain::replay::ReplayBuffer;
use core_domain::serial::{
    build_payload, conflicting_session, same_port, DataBits, FlowControl, LineEnding, Parity,
    SendMode, SerialConfig, StopBits,
};
use core_domain::utf8_stream::Utf8Stream;
use core_domain::workspace::{SessionMeta, SessionSettings, Workspace};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use transport::{SerialTransport, Transport, TransportStatus};
use uuid::Uuid;

mod fsview;
mod history;
mod persistence;
mod profiles;
mod session_log;
mod shellmenu;
mod shortcut_export;
mod transport;

/// 一个会话的运行时句柄。输入所有权、状态机等后续模块都挂在这里。
/// 标题不在这里：唯一真源是工作区里的 `SessionMeta`，见 `pty_list`。
struct Session {
    created_ms: u64,
    settings: Mutex<SessionSettings>,
    runtime_log: Mutex<Option<session_log::RuntimeLog>>,
    log_path: Mutex<Option<PathBuf>>,
    /// 通道：终端（ConPTY）或串口。会话层不再直接认识管道或 COM 口。
    transport: Arc<dyn Transport>,
    input: Mutex<InputState>,
    /// 最近输出的副本：前端晚附着、切走或页面重载后从这里补上一段
    replay: Mutex<ReplayBuffer>,
    /// 回放缓冲自上次落盘以来有没有新内容（空闲落盘用，见 `IDLE_FLUSH_MS`）
    dirty: AtomicBool,
    /// 暂停接收输出：读线程照常解析、照常记回放，只是不再发 `pty:out`。
    /// 继续时前端按回放整屏重画，所以暂停期间的输出不丢、也不会与 Shell 的屏幕错位。
    paused: AtomicBool,
    /// 串口专用：端口已主动释放（暂停 = 真关句柄，见 M5）。终端恒为 false。
    released: AtomicBool,
    /// 读线程的代次。释放端口、重连、关闭时 +1，让迟到的旧读线程安静退出。
    reader_gen: AtomicU64,
    /// 串口读线程的句柄：释放端口要先 join，否则克隆句柄还占着 COM 口。
    reader_join: Mutex<Option<JoinHandle<()>>>,
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
    /// 共享滴答线程的退出标记；单一调度器替代每会话一个轮询线程。
    tick_running: AtomicBool,
    /// 会话树与布局。内存是唯一写入口，落盘由 [`persist_workspace`] 统一做。
    workspace: Mutex<Workspace>,
    /// 解析失败时为 `None`：本版没有必需落盘的状态，不挡启动
    data_dir: Option<PathBuf>,
    /// 读取失败时禁止覆盖原工作区及备份。
    workspace_writable: bool,
    /// 历史库句柄。`setup` 里拿到 `AppHandle` 后才建（写库线程要发事件）。
    history: OnceLock<Arc<history::History>>,
}

impl AppState {
    fn new(data_dir: Option<PathBuf>, workspace: Workspace, workspace_writable: bool) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tick_running: AtomicBool::new(false),
            workspace: Mutex::new(workspace),
            data_dir,
            workspace_writable,
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

/// 会话 CWD 真变了。文件面板的「跟随」只认这一帧，不是每个提示符都发。
#[derive(Clone, Serialize)]
struct CwdPayload {
    id: String,
    cwd: String,
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
    /// 能力位决定界面隐藏哪些入口（串口没有补全、命令检索与备用屏）
    caps: CapsPayload,
}

#[derive(Clone, Copy, Serialize)]
struct CapsPayload {
    completion: bool,
    history: bool,
    timestamp: bool,
    alt_screen: bool,
}

impl From<core_domain::serial::Capabilities> for CapsPayload {
    fn from(caps: core_domain::serial::Capabilities) -> Self {
        Self {
            completion: caps.completion,
            history: caps.history,
            timestamp: caps.timestamp,
            alt_screen: caps.alt_screen,
        }
    }
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
    /// 串口会话才有：冷会话重新拉起时按这份配置重连，界面也用它显示 8N1 摘要。
    serial: Option<SerialConfigPayload>,
    settings: SessionSettingsPayload,
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct SessionSettingsPayload {
    cr_as_newline: bool,
    console_timestamps: bool,
    file_timestamps: bool,
    timestamp_format: String,
    log_directory: Option<String>,
    log_filename: String,
    logging: bool,
    /// 暂停/继续（断开/连接）时换新日志文件。老前端不带这个字段时按关闭处理。
    #[serde(default)]
    new_log_on_toggle: bool,
    /// 终端字号。老前端不带这个字段时按默认值走（见 `#[serde(default)]`）。
    #[serde(default = "default_font_size")]
    font_size: u16,
}

fn default_font_size() -> u16 {
    core_domain::workspace::DEFAULT_FONT_SIZE
}

impl From<&SessionSettings> for SessionSettingsPayload {
    fn from(value: &SessionSettings) -> Self {
        Self {
            cr_as_newline: value.cr_as_newline,
            console_timestamps: value.console_timestamps,
            file_timestamps: value.file_timestamps,
            timestamp_format: value.timestamp_format.clone(),
            log_directory: value.log_directory.clone(),
            log_filename: value.log_filename.clone(),
            logging: value.logging,
            new_log_on_toggle: value.new_log_on_toggle,
            font_size: value.font_size,
        }
    }
}

impl SessionSettingsPayload {
    fn into_settings(self) -> SessionSettings {
        SessionSettings {
            cr_as_newline: self.cr_as_newline,
            console_timestamps: self.console_timestamps,
            file_timestamps: self.file_timestamps,
            timestamp_format: self.timestamp_format,
            log_directory: self.log_directory,
            log_filename: self.log_filename,
            logging: self.logging,
            new_log_on_toggle: self.new_log_on_toggle,
            // 越界值夹回合法区间：宁可显示成 9 或 28，也不要一个看不见字的终端
            font_size: self
                .font_size
                .clamp(core_domain::workspace::MIN_FONT_SIZE, core_domain::workspace::MAX_FONT_SIZE),
        }
    }
}

/// 串口配置的 IPC 形态。core-domain 里的枚举在这里翻成稳定字符串，
/// 前端只负责展示与回传，不复制任何默认值或校验规则。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SerialConfigPayload {
    port: String,
    baud: u32,
    data_bits: u8,
    parity: String,
    stop_bits: String,
    flow: String,
    dtr: bool,
    rts: bool,
    line_ending: String,
    send_mode: String,
}

impl From<&SerialConfig> for SerialConfigPayload {
    fn from(config: &SerialConfig) -> Self {
        Self {
            port: config.port.trim().to_string(),
            baud: config.baud,
            data_bits: config.data_bits.value(),
            parity: config.parity.as_str().to_string(),
            stop_bits: config.stop_bits.as_str().to_string(),
            flow: config.flow.as_str().to_string(),
            dtr: config.dtr,
            rts: config.rts,
            line_ending: config.line_ending.as_str().to_string(),
            send_mode: config.send_mode.as_str().to_string(),
        }
    }
}

impl SerialConfigPayload {
    fn into_config(self) -> Result<SerialConfig, String> {
        let data_bits = DataBits::from_value(self.data_bits)
            .ok_or_else(|| format!("数据位只能是 5–8，收到 {}", self.data_bits))?;
        let parity = Parity::from_str(&self.parity)
            .ok_or_else(|| format!("未知校验方式 {}", self.parity))?;
        let stop_bits = StopBits::from_str(&self.stop_bits)
            .ok_or_else(|| format!("未知停止位 {}", self.stop_bits))?;
        let flow =
            FlowControl::from_str(&self.flow).ok_or_else(|| format!("未知流控 {}", self.flow))?;
        let line_ending = LineEnding::from_str(&self.line_ending)
            .ok_or_else(|| format!("未知行结束符 {}", self.line_ending))?;
        let send_mode = SendMode::from_str(&self.send_mode)
            .ok_or_else(|| format!("未知发送方式 {}", self.send_mode))?;
        let config = SerialConfig {
            port: self.port.trim().to_string(),
            baud: self.baud,
            data_bits,
            parity,
            stop_bits,
            flow,
            dtr: self.dtr,
            rts: self.rts,
            line_ending,
            send_mode,
        };
        config.validate().map_err(|err| err.to_string())?;
        Ok(config)
    }
}

/// 一个串口可选项。字段与 `transport::PortInfo` 一一对应。
#[derive(Serialize)]
struct SerialPortPayload {
    port: String,
    kind: &'static str,
    vid: Option<u16>,
    pid: Option<u16>,
    manufacturer: Option<String>,
    product: Option<String>,
    serial_number: Option<String>,
    friendly_name: Option<String>,
}

impl From<transport::PortInfo> for SerialPortPayload {
    fn from(info: transport::PortInfo) -> Self {
        Self {
            port: info.port,
            kind: info.kind,
            vid: info.vid,
            pid: info.pid,
            manufacturer: info.manufacturer,
            product: info.product,
            serial_number: info.serial_number,
            friendly_name: info.friendly_name,
        }
    }
}

/// 串口当前状态。`status` 三态与 `TransportStatus` 同义；`paused` 是用户主动断开。
/// `summary` 是 `115200 8N1` 这类一句话摘要，规则在 core-domain，前端只显示。
#[derive(Clone, Serialize)]
struct SerialStatusPayload {
    id: String,
    status: &'static str,
    error: Option<String>,
    log: Option<String>,
    paused: bool,
    summary: String,
    config: SerialConfigPayload,
}

/// 文件面板列目录的一行（M4）。顺序由后端定：目录在前，名字大小写不敏感。
#[derive(Serialize)]
struct FsEntryPayload {
    name: String,
    kind: &'static str,
    /// 符号链接（按目标类型显示，指向目录的仍然能进入）
    link: bool,
    /// 只有普通文件有意义
    size: u64,
    /// UTC 毫秒；文件系统不提供时间时为 null
    modified_ms: Option<i64>,
    /// UTC 毫秒；文件系统不提供创建时间时为 null
    created_ms: Option<i64>,
    hidden: bool,
}

/// 一次列目录的完整结果。`total` 是过滤前的条目数，`truncated` 说明只返回了前一段。
#[derive(Serialize)]
struct FsListingPayload {
    path: String,
    parent: Option<String>,
    total: usize,
    hidden_count: usize,
    truncated: bool,
    entries: Vec<FsEntryPayload>,
}

impl From<core_domain::fsview::Entry> for FsEntryPayload {
    fn from(entry: core_domain::fsview::Entry) -> Self {
        Self {
            name: entry.name,
            kind: entry.kind.as_str(),
            link: entry.link,
            size: entry.size,
            modified_ms: entry.modified_ms,
            created_ms: entry.created_ms,
            hidden: entry.hidden,
        }
    }
}

impl From<core_domain::fsview::Listing> for FsListingPayload {
    fn from(listing: core_domain::fsview::Listing) -> Self {
        Self {
            path: listing.path,
            parent: listing.parent,
            total: listing.total,
            hidden_count: listing.hidden_count,
            truncated: listing.truncated,
            entries: listing
                .entries
                .into_iter()
                .map(FsEntryPayload::from)
                .collect(),
        }
    }
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
    if !state.workspace_writable {
        return;
    }
    let Some(dir) = state.data_dir.as_deref() else {
        return;
    };
    let workspace = state.workspace.lock();
    if let Err(err) = persistence::save_workspace(dir, &workspace) {
        eprintln!("[data] save workspace: {err}");
    }
}

/// 当前判定。唯一的规则来源是 `core_domain::ownership::decide`。
fn ownership_of(id: &str, kind: TransportKind, input: &InputState) -> OwnershipPayload {
    let state = input.tracker.view();
    let decision = decide(kind, state, input.ovr);
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
    let kind = session.transport.kind();
    let payload = {
        let mut input = session.input.lock();
        let current = ownership_of(id, kind, &input);
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
        if payload.confidence == "guess" {
            " (guess)"
        } else {
            ""
        }
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

/// Windows 的 verbatim 前缀（`\\?\`）不能交给 MSYS 程序：Git Bash 打开这种路径会失败，
/// 而且 `--init-file` 失败时不会报错，集成脚本就整段没跑、会话永远停在「未知 · 直通」。
/// 资源目录在 Windows 上常常带这个前缀，返回前统一去掉。
fn unverbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// 集成脚本的位置：安装版取资源目录，开发版回退到仓库里的脚本。
fn integration_script(app: &AppHandle, name: &str) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("integration").join(name);
        if packaged.is_file() {
            return Some(unverbatim(packaged));
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
    let transport: Arc<dyn Transport> = Arc::new(transport::PtyTransport::new(
        writer,
        pair.master,
        child,
        cols,
        rows,
    ));
    let session = new_session(transport);
    let saved = state
        .workspace
        .lock()
        .session(&id)
        .map(|meta| meta.settings.clone())
        .unwrap_or_default();
    *session.runtime_log.lock() = Some(session_log::RuntimeLog::new(saved.clone())?);
    *session.settings.lock() = saved;

    // 冷会话重开：把上次的屏幕接在新输出前面。必须在读线程启动前做，
    // 否则新输出会先占序号、快照反而画在后面。
    seed_scrollback(&state, &session, &id);

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
                meta.serial = None;
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

    start_pumps(&app, &session, &id);
    start_reader(app.clone(), session.clone(), id.clone());
    push_ownership(&app, &session, &id);
    Ok(id)
}

/// 装配一个会话运行时。终端与串口共用同一份状态：回放、输入判定、输出合流。
fn new_session(transport: Arc<dyn Transport>) -> Arc<Session> {
    let outbox = Arc::new(OutMailbox {
        pending: Mutex::new(Coalescer::new()),
        running: AtomicBool::new(true),
    });
    Arc::new(Session {
        created_ms: now_ms(),
        transport,
        settings: Mutex::new(SessionSettings::default()),
        runtime_log: Mutex::new(None),
        log_path: Mutex::new(None),
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
        released: AtomicBool::new(false),
        reader_gen: AtomicU64::new(0),
        reader_join: Mutex::new(None),
        outbox,
    })
}

/// 冷会话重开：把上次的屏幕接在新输出前面（见 `core_domain::scrollback`）。
fn seed_scrollback(state: &AppState, session: &Session, id: &str) {
    let Some(dir) = state.data_dir.as_deref() else {
        return;
    };
    if let Some(previous) = persistence::load_scrollback(dir, id) {
        let seeded = core_domain::scrollback::compose(&previous);
        if !seeded.is_empty() {
            session.replay.lock().push(&seeded);
        }
    }
}

/// 每个会话一条输出发送线程；所有会话共享一条静默/落盘调度线程。
fn start_pumps(app: &AppHandle, session: &Arc<Session>, id: &str) {
    {
        let app_for_out = app.clone();
        let session_for_out = session.clone();
        let out_id = id.to_string();
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

    let state = app.state::<AppState>();
    if !state.tick_running.swap(true, Ordering::SeqCst) {
        let app_for_tick = app.clone();
        std::thread::spawn(move || {
            while app_for_tick
                .state::<AppState>()
                .tick_running
                .load(Ordering::Relaxed)
            {
                std::thread::sleep(Duration::from_millis(300));
                let state = app_for_tick.state::<AppState>();
                let sessions: Vec<(String, Arc<Session>)> = state
                    .sessions
                    .lock()
                    .iter()
                    .map(|(id, session)| (id.clone(), session.clone()))
                    .collect();
                for (id, session) in sessions {
                    let quiet = {
                        let mut input = session.input.lock();
                        let quiet = now_ms().saturating_sub(input.last_output_ms);
                        let at_line_start = input.at_line_start;
                        input.tracker.on_silence(quiet, at_line_start);
                        quiet
                    };
                    if session.transport.kind() == TransportKind::Terminal {
                        push_ownership(&app_for_tick, &session, &id);
                    }
                    if quiet >= IDLE_FLUSH_MS
                        && session.dirty.swap(false, Ordering::Relaxed)
                        && !save_session_scrollback(&state, &session, &id)
                    {
                        session.dirty.store(true, Ordering::Relaxed);
                    }
                }
            }
        });
    }
}

/// 起一个读线程。终端只会起一次；串口每次「连接」都起一个新的，
/// 互斥靠 `reader_gen`：旧线程醒来发现代次变了就安静退出，不做收尾。
fn start_reader(app: AppHandle, session: Arc<Session>, id: String) {
    let generation = session.reader_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let kind = session.transport.kind();
    let thread_session = session.clone();
    let handle = std::thread::spawn(move || {
        let mut reader = match thread_session.transport.take_reader() {
            Ok(reader) => reader,
            Err(err) => {
                thread_session.transport.note_failure(&err);
                emit_serial_status(&app, &thread_session, &id);
                return;
            }
        };
        let mut buf = [0u8; 8192];
        let mut stream = Utf8Stream::new();
        let mut parser = OscParser::new();
        let mut read_error: Option<String> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if kind == TransportKind::Serial {
                        // 串口没有 Shell，也就没有 OSC 标记：字节直接当屏幕内容，
                        // 同时按原始字节写日志（用户看到的是解码后的文本，日志保留原样）。
                        thread_session.transport.log_rx(&buf[..n]);
                        thread_session.input.lock().last_output_ms = now_ms();
                        let decoded = stream.push(&buf[..n]);
                        if !decoded.is_empty() {
                            let text = thread_session
                                .runtime_log
                                .lock()
                                .as_mut()
                                .and_then(|log| log.receive(&decoded, true).ok())
                                .unwrap_or(decoded);
                            let seq = thread_session.replay.lock().push(&text).unwrap_or_default();
                            thread_session.dirty.store(true, Ordering::Relaxed);
                            thread_session.outbox.pending.lock().push(&text, seq);
                        }
                        continue;
                    }

                    let events = parser.feed(&buf[..n]);
                    {
                        let mut input = thread_session.input.lock();
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
                                    note_cwd(&app, &id, path);
                                }
                                let _ = app.emit(
                                    "pty:marker",
                                    MarkerEvent {
                                        id: id.clone(),
                                        marker,
                                    },
                                );
                            }
                        }
                        push_ownership(&app, &thread_session, &id);
                    }
                    let raw_text = stream.push(&buf[..n]);
                    if !raw_text.is_empty() {
                        let text = thread_session
                            .runtime_log
                            .lock()
                            .as_mut()
                            .and_then(|log| log.receive(&raw_text, false).ok())
                            .unwrap_or(raw_text);
                        // 先记回放再发事件：凡是被前端看到过的块，一定也能被回放到
                        let seq = thread_session.replay.lock().push(&text).unwrap_or_default();
                        thread_session.dirty.store(true, Ordering::Relaxed);
                        // 暂停只掐事件，不掐回放：继续时前端按回放整屏重画，暂停期间的内容
                        // 还在（受 REPLAY_CAP_BYTES 限制，超出部分按整块丢）。这样既省掉
                        // 刷屏时的 IPC，又不会让暂停期间的终端查询（DSR 之类）永远丢答。
                        //
                        // 事件不在这里直接发：先攒进合流缓冲，由发送线程按帧发出去。
                        // 刷屏时这里一秒会跑上千次，逐块发 IPC 的代价全落在主线程与前端。
                        thread_session.outbox.pending.lock().push(&text, seq);
                    }
                }
                Err(err) => {
                    read_error = Some(format!("读串口失败：{err}"));
                    break;
                }
            }
        }

        // 旧线程（被断开、重连或关闭顶掉）不负责收尾
        if thread_session.reader_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        // 串口断开时读端按设计结束：会话仍是热的，等用户「连接」
        if thread_session.transport.status() == TransportStatus::Released {
            return;
        }

        if kind == TransportKind::Serial {
            // 设备拔掉/读失败：会话保持热的，状态标为失败，让用户决定重连还是关闭
            let message = read_error.unwrap_or_else(|| "串口连接已结束".to_string());
            thread_session.transport.note_failure(&message);
            emit_serial_status(&app, &thread_session, &id);
            return;
        }

        // 终端：读循环结束 = 进程退出/被关。先停发送线程，再把最后一块发出去，
        // 最后才发退出事件。顺序反了会让屏幕上的最后一段内容落在「[进程已退出]」之后。
        thread_session
            .outbox
            .running
            .store(false, Ordering::Relaxed);
        if let Some((data, seq)) = thread_session.outbox.pending.lock().take() {
            if !thread_session.paused.load(Ordering::Relaxed) {
                let _ = app.emit(
                    "pty:out",
                    OutPayload {
                        id: id.clone(),
                        seq,
                        data,
                    },
                );
            }
        }
        // 通道结束（进程退出/被关）：先落卷轴快照、摘掉运行时、标记冷会话，再通知前端
        {
            let state = app.state::<AppState>();
            // 用户主动关闭的会话，节点已经删掉，不再补一份快照回来（I2）。
            // 单独取值：不能让 workspace 的锁活在条件里，下面还要再取一次。
            let still_known = state.workspace.lock().session(&id).is_some();
            if still_known {
                save_session_scrollback(&state, &thread_session, &id);
            }
            state.sessions.lock().remove(&id);
            {
                let mut workspace = state.workspace.lock();
                let _ = workspace.set_hot(&id, false);
            }
            persist_workspace(&state);
        }
        let _ = app.emit("pty:exit", ExitPayload { id });
    });

    // 只有串口需要 join：释放端口前必须等克隆句柄也关掉，否则 COM 口仍被占着
    if kind == TransportKind::Serial {
        *session.reader_join.lock() = Some(handle);
    }
}

fn join_reader(session: &Session) {
    let handle = session.reader_join.lock().take();
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

fn status_name(status: TransportStatus) -> &'static str {
    match status {
        TransportStatus::Open => "open",
        TransportStatus::Released => "released",
        TransportStatus::Failed => "failed",
    }
}

fn serial_status_of(id: &str, session: &Session) -> SerialStatusPayload {
    let config = session
        .transport
        .serial_config()
        .unwrap_or_else(|| SerialConfig::new(""));
    SerialStatusPayload {
        id: id.to_string(),
        status: status_name(session.transport.status()),
        error: session.transport.last_error(),
        log: session
            .transport
            .log_path()
            .map(|path| path.display().to_string()),
        paused: session.released.load(Ordering::Relaxed),
        summary: config.summary(),
        config: (&config).into(),
    }
}

fn emit_serial_status(app: &AppHandle, session: &Session, id: &str) {
    if session.transport.kind() != TransportKind::Serial {
        return;
    }
    let _ = app.emit("serial:status", serial_status_of(id, session));
}

/// I4：同一个串口不允许两个热会话。暂停不改变「热」——端口让出去是给别的程序用的，
/// 不是给本应用的第二个会话用的。判定规则只有一处：`core_domain::serial::conflicting_session`。
fn port_conflict(state: &AppState, port: &str, except: &str) -> Option<String> {
    let sessions = state.sessions.lock();
    let ports: Vec<(String, String)> = sessions
        .iter()
        .filter_map(|(id, session)| session.transport.port_key().map(|key| (id.clone(), key)))
        .collect();
    let pairs: Vec<(&str, &str)> = ports
        .iter()
        .map(|(id, key)| (id.as_str(), key.as_str()))
        .collect();
    conflicting_session(pairs, port, except).map(str::to_string)
}

/// 错误里点名的会话 id：取前 8 个字符。按字符截，不按字节——
/// 一旦有人用非 ASCII 的 id，按字节切会切在字符中间直接 panic。
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// 打开一个串口会话。`session_id` 存在时表示冷会话重新拉起：端口配置以工作区为准，
/// 传进来的 `config` 只在新建会话时使用（前端仍会带上，方便两边显示一致）。
#[tauri::command]
fn spawn_serial_session(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SerialConfigPayload,
    session_id: Option<String>,
) -> Result<String, String> {
    if let Some(id) = session_id.as_deref() {
        if state.sessions.lock().contains_key(id) {
            return Err(format!("session {id} is already live"));
        }
    }

    let id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    // 冷会话重新拉起按工作区里记住的配置（端口可能被用户改过），新建才用请求里的
    let saved = state
        .workspace
        .lock()
        .session(&id)
        .and_then(|meta| meta.serial.clone());
    let config = match saved {
        Some(saved) => saved,
        None => config.into_config()?,
    };
    if let Some(other) = port_conflict(&state, &config.port, &id) {
        return Err(format!(
            "{} 已被另一个会话占用（{}）：同一串口不允许两个热会话",
            config.port.trim(),
            short_id(&other)
        ));
    }

    let transport: Arc<dyn Transport> = if transport::fake_serial_enabled()
        && same_port(&config.port, transport::fake::FAKE_PORT)
    {
        // 开发/演示用：内存回环，完全不碰系统端口
        let (transport, _peer) = transport::fake::MemoryTransport::loopback(config.clone());
        Arc::new(transport)
    } else {
        Arc::new(SerialTransport::open(
            config.clone(),
            &id,
            state.data_dir.as_deref(),
        )?)
    };
    let title = config.default_title();
    let session = new_session(transport);
    let saved = state
        .workspace
        .lock()
        .session(&id)
        .map(|meta| meta.settings.clone())
        .unwrap_or_default();
    *session.runtime_log.lock() = Some(session_log::RuntimeLog::new(saved.clone())?);
    *session.settings.lock() = saved;
    seed_scrollback(&state, &session, &id);
    state.sessions.lock().insert(id.clone(), session.clone());

    {
        let mut workspace = state.workspace.lock();
        match workspace.session_mut(&id) {
            Some(meta) => {
                meta.transport = TransportKind::Serial;
                meta.shell = None;
                meta.serial = Some(config.clone());
                meta.cwd = None;
                meta.hot = true;
            }
            None => {
                let mut meta = SessionMeta::serial(id.clone(), title, config.clone());
                meta.hot = true;
                let _ = workspace.add_session(meta);
            }
        }
    }
    persist_workspace(&state);

    start_pumps(&app, &session, &id);
    start_reader(app.clone(), session.clone(), id.clone());
    push_ownership(&app, &session, &id);
    emit_serial_status(&app, &session, &id);
    Ok(id)
}

/// 端口列表。枚举会碰系统设备，放到阻塞线程池，别占着 IPC 线程。
#[tauri::command]
async fn serial_ports() -> Vec<SerialPortPayload> {
    match tauri::async_runtime::spawn_blocking(transport::available_ports).await {
        Ok(list) => list.into_iter().map(SerialPortPayload::from).collect(),
        Err(err) => {
            eprintln!("[serial] 枚举端口失败: {err}");
            Vec::new()
        }
    }
}

/// 串口会话的当前状态（状态点、错误、日志路径、配置摘要）。
#[tauri::command]
fn serial_status(state: State<'_, AppState>, id: String) -> Result<SerialStatusPayload, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    Ok(serial_status_of(&id, &session))
}

/// 暂停/继续（串口是断开/连接）之后的日志切分：按会话设置决定下一条记录是否写进新文件。
/// 新建的串口会话已经在 `RuntimeLog::new` 里开过文件，这里只管「切换」这一下。
fn mark_session_log_rotation(session: &Session) {
    if let Some(log) = session.runtime_log.lock().as_mut() {
        log.mark_new_file();
    }
}

/// 断开串口：真正关闭句柄，让别的程序也能用这个口。会话保持热的，回放与历史都不动。
fn disconnect_serial(app: &AppHandle, id: &str, session: &Arc<Session>) -> Result<(), String> {
    if session.released.swap(true, Ordering::SeqCst) {
        return Ok(()); // 已经断开
    }
    // 先让旧读线程的收尾作废，再关句柄；join 保证克隆句柄也关掉了
    session.reader_gen.fetch_add(1, Ordering::SeqCst);
    let result = session.transport.release();
    join_reader(session);
    session.outbox.pending.lock().clear();
    mark_session_log_rotation(session);
    emit_serial_status(app, session, id);
    result
}

/// 重新连接串口：按工作区里记住的配置重开端口，并起一个新的读线程。
fn connect_serial(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    session: &Arc<Session>,
) -> Result<(), String> {
    let config = session
        .transport
        .serial_config()
        .ok_or_else(|| "串口配置缺失".to_string())?;
    if let Some(other) = port_conflict(state, &config.port, id) {
        return Err(format!(
            "{} 已被另一个会话占用（{}）",
            config.port.trim(),
            short_id(&other)
        ));
    }
    // 已经好好连着：什么都没变，别为一个空动作把读线程重启一遍
    let released = session.released.load(Ordering::SeqCst);
    if !released && session.transport.status() == TransportStatus::Open {
        return Ok(());
    }
    // 走到这里有两种情况：用户主动断开（Released），或读写出错（Failed）。
    // 两种情况都要先把旧句柄与旧读线程收干净，再真开一次端口。
    session.reader_gen.fetch_add(1, Ordering::SeqCst);
    if session.transport.status() != TransportStatus::Released {
        let _ = session.transport.release();
    }
    join_reader(session);
    session.outbox.pending.lock().clear();
    if let Err(err) = session.transport.reopen() {
        session.released.store(true, Ordering::SeqCst);
        emit_serial_status(app, session, id);
        return Err(err);
    }
    session.released.store(false, Ordering::SeqCst);
    // 先排上翻页再起读线程：重连后的第一块输出就应该进新文件
    mark_session_log_rotation(session);
    start_reader(app.clone(), session.clone(), id.to_string());
    emit_serial_status(app, session, id);
    Ok(())
}

#[tauri::command]
fn serial_update_config(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    config: SerialConfigPayload,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or("会话未运行")?;
    let config = config.into_config()?;
    if session.transport.kind() != TransportKind::Serial {
        return Err("不是串口会话".into());
    }
    let was_open = !session.released.load(Ordering::Relaxed)
        && session.transport.status() == TransportStatus::Open;
    if was_open {
        disconnect_serial(&app, &id, &session)?;
    }
    session.transport.set_serial_config(config.clone())?;
    if let Some(meta) = state.workspace.lock().session_mut(&id) {
        meta.serial = Some(config);
    }
    persist_workspace(&state);
    if was_open {
        connect_serial(&app, &state, &id, &session)?;
    }
    Ok(())
}

#[tauri::command]
fn serial_disconnect(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    if session.transport.kind() != TransportKind::Serial {
        return Err("不是串口会话".into());
    }
    disconnect_serial(&app, &id, &session)
}

#[tauri::command]
fn serial_connect(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    if session.transport.kind() != TransportKind::Serial {
        return Err("不是串口会话".into());
    }
    connect_serial(&app, &state, &id, &session)
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
        let _ = app.emit(
            "session:cwd",
            CwdPayload {
                id: id.to_string(),
                cwd: path.to_string(),
            },
        );
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

    // 提交意图先于字节生效：回车一按就停止接管，比等标记回来更保守。
    // 串口没有提示符状态，判定恒归输入条，不需要推进。
    if session.transport.kind() == TransportKind::Terminal && is_submit(data) {
        session.input.lock().tracker.on_submit();
        push_ownership(app, &session, id);
    }

    session.transport.write(data.as_bytes())?;
    if let Some(log) = session.runtime_log.lock().as_mut() {
        let _ = log.transmit(data);
    }

    // 先发通道、再排进历史库的单写线程：落盘失败不影响内容已经发出去（M3）
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
///
/// 终端固定追加 `\r`（L0-12）。串口按会话的发送方式与行结束符组包；
/// `hex` 为真时按整行十六进制解析，绝不追加行结束符（HEX 一律整行原样发送）。
#[tauri::command]
fn pty_send_line(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    line: String,
    hex: Option<bool>,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;

    let Some(config) = session.transport.serial_config() else {
        return write_session(&app, &state, &id, &format!("{line}\r"), true);
    };

    // 串口：端口断着就别假装发出去了，前端会把这一行留在输入条上
    if session.released.load(Ordering::Relaxed) {
        return Err("端口已断开，先点「连接」".into());
    }
    if session.transport.status() == TransportStatus::Failed {
        return Err(session
            .transport
            .last_error()
            .unwrap_or_else(|| "串口连接已断开".into()));
    }
    let payload = build_payload(
        &line,
        config.send_mode,
        config.line_ending,
        hex.unwrap_or(false),
    )
    .map_err(|err| err.to_string())?;
    session.transport.write(&payload)?;
    if let Some(log) = session.runtime_log.lock().as_mut() {
        let _ = log.transmit(&line);
    }
    // 发送历史（↑↓）与命令历史共用一张表：串口没有补全与检索，但仍要能翻上一次写的内容
    if let Some(history) = state.history() {
        history.record(&id, &line, now_ms());
    }
    Ok(())
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
            caps: session.transport.capabilities().into(),
        })
        .collect();
    list.sort_by_key(|info| info.created_ms);
    list
}

/// 活会话状态批量快照：避免前端每次刷新会话树时对每个会话单独发 IPC。
#[tauri::command]
fn session_runtime_states(state: State<'_, AppState>) -> Vec<RuntimeStatePayload> {
    let sessions = state.sessions.lock();
    sessions
        .iter()
        .map(|(id, session)| RuntimeStatePayload {
            id: id.clone(),
            transport: if session.transport.kind() == TransportKind::Serial {
                "serial"
            } else {
                "terminal"
            },
            paused: session.paused.load(Ordering::Relaxed)
                || session.released.load(Ordering::Relaxed),
            serial: (session.transport.kind() == TransportKind::Serial)
                .then(|| serial_status_of(id, session)),
        })
        .collect()
}

#[derive(Serialize)]
struct RuntimeStatePayload {
    id: String,
    transport: &'static str,
    paused: bool,
    serial: Option<SerialStatusPayload>,
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
            serial: session.serial.as_ref().map(SerialConfigPayload::from),
            settings: SessionSettingsPayload::from(&session.settings),
        })
        .collect()
}

#[derive(Serialize)]
struct SessionSettingsResult {
    settings: SessionSettingsPayload,
    serial: Option<SerialConfigPayload>,
}

#[tauri::command]
fn session_settings_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionSettingsResult, String> {
    let workspace = state.workspace.lock();
    let meta = workspace
        .session(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    Ok(SessionSettingsResult {
        settings: SessionSettingsPayload::from(&meta.settings),
        serial: meta.serial.as_ref().map(SerialConfigPayload::from),
    })
}

#[tauri::command]
fn session_settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    settings: SessionSettingsPayload,
    serial: Option<SerialConfigPayload>,
) -> Result<(), String> {
    let settings = settings.into_settings();
    let serial_config = serial.map(SerialConfigPayload::into_config).transpose()?;
    if settings.logging
        && settings
            .log_directory
            .as_deref()
            .map_or(true, |path| !Path::new(path).is_dir())
    {
        return Err("请先选择有效的日志文件夹".into());
    }
    let live_session = { state.sessions.lock().get(&id).cloned() };
    if let Some(session) = live_session {
        if let Some(config) = serial_config.clone() {
            if config != session.transport.serial_config().ok_or("不是串口会话")? {
                let was_open = session.transport.status() == TransportStatus::Open
                    && !session.released.load(Ordering::Relaxed);
                if was_open {
                    disconnect_serial(&app, &id, &session)?;
                }
                session.transport.set_serial_config(config.clone())?;
                if let Some(meta) = state.workspace.lock().session_mut(&id) {
                    meta.serial = Some(config.clone());
                }
                persist_workspace(&state);
                if was_open {
                    connect_serial(&app, &state, &id, &session)?;
                }
            }
        }
        let mut runtime = session.runtime_log.lock();
        if let Some(log) = runtime.as_mut() {
            log.update(settings.clone())?;
        } else {
            *runtime = Some(session_log::RuntimeLog::new(settings.clone())?);
        }
        *session.log_path.lock() = runtime
            .as_ref()
            .and_then(|log| log.path().map(Path::to_path_buf));
        *session.settings.lock() = settings.clone();
    }
    let mut workspace = state.workspace.lock();
    let meta = workspace
        .session_mut(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    if let Some(config) = serial_config {
        meta.serial = Some(config);
    }
    meta.settings = settings;
    drop(workspace);
    persist_workspace(&state);
    let _ = app.emit("session:settings", id);
    Ok(())
}

#[tauri::command]
fn session_log_start(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or("会话未运行")?;
    let mut settings = state
        .workspace
        .lock()
        .session(&id)
        .ok_or("会话不存在")?
        .settings
        .clone();
    settings.logging = true;
    let directory = settings.log_directory.clone().ok_or("请先选择日志文件夹")?;
    let mut runtime = session.runtime_log.lock();
    if let Some(log) = runtime.as_mut() {
        log.update(settings.clone())?;
    } else {
        *runtime = Some(session_log::RuntimeLog::new(settings.clone())?);
    }
    *session.settings.lock() = settings.clone();
    state
        .workspace
        .lock()
        .session_mut(&id)
        .ok_or("会话不存在")?
        .settings = settings;
    persist_workspace(&state);
    let path = runtime
        .as_ref()
        .and_then(|log| log.path().map(Path::to_path_buf));
    *session.log_path.lock() = path.clone();
    Ok(path.map(|p| p.display().to_string()).unwrap_or(directory))
}

#[tauri::command]
fn session_log_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or("会话未运行")?;
    let mut settings = session.settings.lock().clone();
    settings.logging = false;
    if let Some(log) = session.runtime_log.lock().as_mut() {
        log.update(settings.clone())?;
    }
    *session.settings.lock() = settings.clone();
    if let Some(meta) = state.workspace.lock().session_mut(&id) {
        meta.settings = settings;
    }
    persist_workspace(&state);
    Ok(())
}

/// 文件面板列一层目录（M4）。`path` 为空时跟随 `session` 记下的 CWD；
/// 会话没有 CWD（还没上报过提示符）就用用户主目录，保证面板永远有东西可显示。
///
/// 读盘放到阻塞线程池：网络盘或超大目录慢的时候，不能让 WebView 的 IPC 排队。
#[tauri::command]
async fn fs_list(
    state: State<'_, AppState>,
    session: Option<String>,
    path: Option<String>,
    show_hidden: Option<bool>,
) -> Result<FsListingPayload, String> {
    let requested = path.filter(|path| !path.trim().is_empty()).or_else(|| {
        let workspace = state.workspace.lock();
        session
            .as_deref()
            .and_then(|id| workspace.session(id))
            .and_then(|meta| {
                meta.settings
                    .log_directory
                    .clone()
                    .or_else(|| meta.cwd.clone())
            })
    });
    let target = PathBuf::from(requested.unwrap_or_else(home_dir));
    let show_hidden = show_hidden.unwrap_or(false);

    let listing = tauri::async_runtime::spawn_blocking(move || fsview::list(&target, show_hidden))
        .await
        .map_err(|err| format!("读取目录失败: {err}"))??;
    Ok(FsListingPayload::from(listing))
}

/// 用默认程序打开这一项（文件 → 关联程序；目录 → 资源管理器）。
///
/// 打开动作统一交给系统的 shell 关联，不在本应用里维护「哪个扩展名用什么程序」。
#[tauri::command]
fn fs_open(path: String) -> Result<(), String> {
    launch_shell(&path, false)
}

/// 在资源管理器中定位：打开父目录并选中这一项（右键菜单里的「在资源管理器中显示」）。
#[tauri::command]
fn fs_reveal(path: String) -> Result<(), String> {
    launch_shell(&path, true)
}

/// 文件面板的原生右键菜单。helper 在独立进程里跑，返回三态：
/// `handled` / `cancelled` / `unavailable`（后者由前端画自建菜单）。
///
/// `background` 为真时弹目录自己的背景菜单（右键空白处：新建 / 粘贴 / 属性……），
/// 否则是某个文件或目录条目的菜单。
#[tauri::command]
async fn fs_context_menu(
    window: tauri::WebviewWindow,
    path: String,
    background: Option<bool>,
) -> Result<String, String> {
    let background = background.unwrap_or(false);
    let target = Path::new(&path);
    if background {
        if !target.is_dir() {
            return Err(format!("不是目录: {path}"));
        }
    } else if !target.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    #[cfg(windows)]
    let hwnd = window.hwnd().map(|handle| handle.0 as usize).unwrap_or(0);
    #[cfg(not(windows))]
    let _ = &window;
    #[cfg(not(windows))]
    let hwnd = 0usize;

    // helper 会一直阻塞到用户选完，所以放阻塞线程池，别占着 IPC 线程。
    let outcome =
        tauri::async_runtime::spawn_blocking(move || shellmenu::run(&path, hwnd, background))
            .await
            .map_err(|err| format!("菜单线程失败: {err}"))?;
    Ok(outcome.as_str().to_string())
}

#[cfg(windows)]
fn launch_shell(path: &str, reveal: bool) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    // explorer 的退出码不可靠（成功也常返回 1），所以只关心「起没起来」。
    let mut command = std::process::Command::new("explorer.exe");
    if reveal {
        // 整体一个参数：`"/select,C:\a b\x"`。外层引号由 Command 补上。
        command.arg(format!("/select,{path}"));
    } else {
        command.arg(path);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法打开: {err}"))
}

#[cfg(not(windows))]
fn launch_shell(_path: &str, _reveal: bool) -> Result<(), String> {
    Err("打开文件或定位目录目前只在 Windows 上支持".into())
}

fn home_dir() -> String {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string()
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

/// 暂停 / 继续。**两种语义**：
/// - 终端：显示层暂停，读线程照常记回放，只是不再发 `pty:out`；
/// - 串口：真断开端口（M5 的验收点），恢复时按原配置重开。
///
/// 返回设置后的状态，前端不必再查一次。
#[tauri::command]
fn pty_set_paused(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    paused: bool,
) -> Result<bool, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    if session.transport.kind() == TransportKind::Serial {
        if paused {
            disconnect_serial(&app, &id, &session)?;
        } else {
            connect_serial(&app, &state, &id, &session)?;
        }
        return Ok(paused);
    }
    session.paused.store(paused, Ordering::Relaxed);
    // 攒着的块：暂停时发出去也没人画，继续时前端按回放整屏重画（再发就等于画两遍）。
    // 直接丢掉，省掉长时间暂停时的内存。
    session.outbox.pending.lock().clear();
    mark_session_log_rotation(&session);
    Ok(paused)
}

/// 当前是否暂停。切会话回来时要按后端状态复原按钮，不能凭前端记忆。
/// 串口的「暂停」是端口已断开（真释放），与终端的显示层暂停并到同一个开关。
#[tauri::command]
fn pty_paused(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    Ok(session.paused.load(Ordering::Relaxed) || session.released.load(Ordering::Relaxed))
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
    Ok(ownership_of(&id, session.transport.kind(), &input))
}

/// 改尺寸。**相同尺寸不下发**：ConPTY 每收到一次 resize（哪怕没变）都会整屏重绘
/// 自己的缓冲，把「清屏」清掉的内容重新吐回来（暂停 → 清屏 → 继续 就是这么复现的）。
/// 重新附着与继续都不该顺手 resize，只有真实的窗口尺寸变化才下发，规则见 `core_domain::resize`。
/// 串口没有尺寸概念，`Transport::resize` 是 no-op。
#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no session {id}"))?;
    session.transport.resize(cols, rows)
}

#[tauri::command]
fn pty_freeze(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // 已经是冷会话：没有运行时可结束，保持原样
    let Some(session) = state.sessions.lock().remove(&id) else {
        return Ok(());
    };
    // 先让旧读线程的收尾作废：冻结不该被当成「进程自然退出」再清理一遍
    session.reader_gen.fetch_add(1, Ordering::SeqCst);
    // 再落快照：进程/端口一关，回放缓冲就没了，下次点开要靠这份快照接回屏幕
    save_session_scrollback(&state, &session, &id);
    // 与 pty_close 的唯一区别：节点留着，只把它标回冷会话
    {
        let mut workspace = state.workspace.lock();
        let _ = workspace.set_hot(&id, false);
    }
    persist_workspace(&state);
    // 与 pty_close 相同：结束通道（终端 = 杀进程，串口 = 关句柄并 join 读线程）
    let _ = session.transport.close();
    if session.transport.kind() == TransportKind::Serial {
        join_reader(&session);
    }
    session.outbox.running.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // 关闭会话 = 节点删除（I2）。先摘节点再结束通道：读线程醒来时看到节点已不在，
    // 就不会把刚删掉的卷轴快照又写回来。
    {
        let mut workspace = state.workspace.lock();
        let _ = workspace.close_session(&id);
    }
    persist_workspace(&state);

    if let Some(session) = state.sessions.lock().remove(&id) {
        // 旧读线程不许再收尾（终端退出/串口断开都不该把会话写回工作区）
        session.reader_gen.fetch_add(1, Ordering::SeqCst);
        let _ = session.transport.close();
        if session.transport.kind() == TransportKind::Serial {
            join_reader(&session);
        }
        session.outbox.running.store(false, Ordering::Relaxed);
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

#[tauri::command]
fn updater_configured() -> bool {
    std::env::var("PINSHELL_UPDATER_PUBKEY").is_ok_and(|key| !key.trim().is_empty())
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
    let mut workspace_writable = true;
    let workspace = match data_dir.as_deref() {
        Ok(dir) => {
            match persistence::load_workspace(dir) {
                persistence::WorkspaceLoad::Loaded(ws) => {
                    println!(
                        "[data] workspace: {} window(s), {} session(s)",
                        ws.windows.len(),
                        ws.sessions.len()
                    );
                    ws
                }
                persistence::WorkspaceLoad::Recovered(ws) => {
                    // Preserve the valid backup until recovery can be committed safely.
                    workspace_writable = false;
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
                    // 原主文件与备份都保留；本次不允许把空工作区写回覆盖它们。
                    eprintln!("[data] workspace unreadable, starting empty without overwriting source: {err}");
                    workspace_writable = false;
                    Workspace::new()
                }
            }
        }
        Err(_) => {
            workspace_writable = false;
            Workspace::new()
        }
    };

    let updater_pubkey = std::env::var("PINSHELL_UPDATER_PUBKEY")
        .ok()
        .filter(|key| !key.trim().is_empty());
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    if let Some(pubkey) = updater_pubkey {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());
        println!("[updater] signed GitHub Releases updates enabled");
    } else {
        println!("[updater] disabled: PINSHELL_UPDATER_PUBKEY is not configured");
    }
    builder
        .manage(AppState::new(data_dir.ok(), workspace, workspace_writable))
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
                        let Ok(settings) = core.Settings() else {
                            return;
                        };
                        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
                            return;
                        };
                        if settings3.SetAreBrowserAcceleratorKeysEnabled(false).is_ok() {
                            let mut on = windows_core::BOOL::default();
                            let _ = settings3.AreBrowserAcceleratorKeysEnabled(&mut on);
                            println!(
                                "[webview] 浏览器加速键: {}",
                                if on.as_bool() {
                                    "on（未生效）"
                                } else {
                                    "off"
                                }
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
            shortcut_export::shortcuts_export_default_path,
            shortcut_export::shortcuts_export_file,
            profiles::terminal_profiles,
            spawn_session,
            spawn_serial_session,
            serial_ports,
            session_settings_get,
            session_settings_save,
            session_log_start,
            session_log_stop,
            serial_status,
            serial_update_config,
            serial_disconnect,
            serial_connect,
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
            session_runtime_states,
            session_tree,
            fs_list,
            fs_open,
            fs_reveal,
            fs_context_menu,
            rename_session,
            pty_resize,
            pty_freeze,
            pty_close,
            updater_configured,
            bench_ping,
            bench_report
        ])
        // 退出应用 = 结束全部进程（I3）。屏幕内容先落成卷轴快照，下次启动接着还原；
        // 页面重载不是退出，会话要留着等前端挂回。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                state.tick_running.store(false, Ordering::Relaxed);
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
                if state.workspace_writable {
                    {
                        let mut workspace = state.workspace.lock();
                        for (id, _) in &sessions {
                            let _ = workspace.set_hot(id, false);
                        }
                    }
                    persist_workspace(&state);
                }
                for (_, session) in sessions {
                    // 终端 = 结束进程；串口 = 关句柄与日志（I3：不保活）
                    let _ = session.transport.close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PinShell");
}

#[cfg(test)]
mod tests {
    use super::{base64_encode, powershell_encoded, unverbatim};
    use std::path::PathBuf;

    /// 资源目录在 Windows 上带 `\\?\` 前缀；交给 Git Bash 前必须去掉，
    /// 否则 `--init-file` 静默失败，提示符标记不出现、输入条永远无法接管。
    #[test]
    fn verbatim_prefix_is_stripped_before_handing_to_msys() {
        assert_eq!(
            unverbatim(PathBuf::from(r"\\?\F:\PinShell\target\debug\integration\pinshell.bash")),
            PathBuf::from(r"F:\PinShell\target\debug\integration\pinshell.bash")
        );
        let plain = PathBuf::from(r"F:\PinShell\scripts\integration\pinshell.bash");
        assert_eq!(unverbatim(plain.clone()), plain);
    }

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
