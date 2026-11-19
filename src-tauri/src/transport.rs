//! 通道抽象：终端（ConPTY）与串口共用同一套会话生命周期。
//!
//! ADR 0001：会话是一条可快照、可回放的 I/O 通道，通道类型只是可替换的传输实现。
//! 这个模块把「字节进出、resize、释放/重开、关闭、能力位」收成一个 trait，会话层
//! （`main.rs`）不再直接认识 ConPTY 或 COM 口。
//!
//! 两条语义差别，别混：
//! - **输出暂停**在会话层（只掐事件，不碰通道）；
//! - **释放**在这里：串口真关句柄（让别的程序也能用这个口），恢复时按原配置重开；
//!   终端不支持释放（它没有独占资源，关闭进程就是结束会话）。

use core_domain::ownership::TransportKind;
use core_domain::resize::SentSize;
use core_domain::serial::{
    capabilities, escape_for_log, format_hex, log_file_name, Capabilities, DataBits, FlowControl,
    LineEnding, Parity, SendMode, SerialConfig, StopBits,
};
use parking_lot::{Condvar, Mutex};
use portable_pty::{Child, MasterPty, PtySize};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 串口读的超时：读线程靠它定期回来看「是不是该退出了」。
/// 太短会空转，太长会让「释放端口」等太久。
pub const SERIAL_READ_TIMEOUT_MS: u64 = 150;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportStatus {
    /// 正常占用
    Open,
    /// 串口被主动释放（会话仍是热的，只是端口不在我们手里）
    Released,
    /// 打开或读写失败；`last_error` 里有原因
    Failed,
}

pub trait Transport: Send + Sync {
    fn kind(&self) -> TransportKind;

    fn capabilities(&self) -> Capabilities;

    /// 写一段字节。串口会话按字节原样写入（组包在调用方，规则见 `core_domain::serial`）。
    fn write(&self, bytes: &[u8]) -> Result<(), String>;

    /// 改尺寸。串口为 no-op；终端会把相同尺寸挡在本地（见 `core_domain::resize`）。
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;

    /// 真释放底层资源。只有串口支持；终端返回错误（它的开关是输出暂停）。
    fn release(&self) -> Result<(), String>;

    /// 重新占用资源。串口按原配置重开；终端不支持。
    fn reopen(&self) -> Result<(), String>;

    /// 关闭通道。终端结束进程；串口释放端口并关掉日志。
    fn close(&self) -> Result<(), String>;

    /// 取读端。每次调用拿一份新的句柄；串口在释放之后返回错误。
    fn take_reader(&self) -> Result<Box<dyn Read + Send>, String>;

    fn status(&self) -> TransportStatus;

    /// 最近一次失败的原因（`status == Failed` 时非空）。
    fn last_error(&self) -> Option<String>;

    /// I4 用：同一个串口不允许两个热会话。终端返回 `None`。
    fn port_key(&self) -> Option<String> {
        None
    }

    /// 串口会话的配置快照；终端返回 `None`。
    fn serial_config(&self) -> Option<SerialConfig> {
        None
    }

    /// 串口日志文件；没有日志时返回 `None`。
    fn log_path(&self) -> Option<PathBuf> {
        None
    }

    /// 记一段收到的原始字节（串口写日志；终端不记）。
    fn log_rx(&self, _bytes: &[u8]) {}

    /// 读线程遇到无法恢复的错误时回报（串口会记成 `Failed`，终端不用）。
    fn note_failure(&self, _message: &str) {}
}

// ---------- 终端（ConPTY） ----------

pub struct PtyTransport {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// 最近一次生效的尺寸。相同尺寸不再下发：ConPTY 每次 resize 都会整屏重绘。
    size: Mutex<SentSize>,
}

impl PtyTransport {
    pub fn new(
        writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            writer: Mutex::new(writer),
            master: Mutex::new(master),
            child: Mutex::new(child),
            size: Mutex::new(SentSize::seeded(cols.max(1), rows.max(1))),
        }
    }
}

impl Transport for PtyTransport {
    fn kind(&self) -> TransportKind {
        TransportKind::Terminal
    }

    fn capabilities(&self) -> Capabilities {
        capabilities(TransportKind::Terminal)
    }

    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock();
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|err| format!("write: {err}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let want = (cols.max(1), rows.max(1));
        let Some((cols, rows)) = self.size.lock().accept(want.0, want.1) else {
            return Ok(());
        };
        self.master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("resize: {err}"))
    }

    fn release(&self) -> Result<(), String> {
        Err("终端会话没有可释放的端口：暂停输出请用「暂停」".into())
    }

    fn reopen(&self) -> Result<(), String> {
        Err("终端会话不能重新连接；请重新拉起会话".into())
    }

    fn close(&self) -> Result<(), String> {
        self.child
            .lock()
            .kill()
            .map_err(|err| format!("kill: {err}"))
    }

    fn take_reader(&self) -> Result<Box<dyn Read + Send>, String> {
        self.master
            .lock()
            .try_clone_reader()
            .map_err(|err| format!("clone reader: {err}"))
    }

    fn status(&self) -> TransportStatus {
        TransportStatus::Open
    }

    fn last_error(&self) -> Option<String> {
        None
    }
}

// ---------- 串口 ----------

/// 串口监控：读线程与写句柄各持一份句柄，释放时先让读线程退出再丢句柄，
/// 否则端口会被另一个句柄继续占着（Windows 上是独占打开）。
struct SerialReader {
    port: Box<dyn serialport::SerialPort + Send>,
    stop: Arc<AtomicBool>,
}

impl Read for SerialReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.stop.load(Ordering::Relaxed) {
                return Ok(0);
            }
            match self.port.read(buf) {
                // 超时不是错误：只是这 150 ms 没数据，回去看看该不该退出
                Err(err) if err.kind() == io::ErrorKind::TimedOut => continue,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                other => return other,
            }
        }
    }
}

pub struct SerialTransport {
    config: Mutex<SerialConfig>,
    port: Mutex<Option<Box<dyn serialport::SerialPort + Send>>>,
    stop: Arc<AtomicBool>,
    status: Mutex<TransportStatus>,
    last_error: Mutex<Option<String>>,
    log: Mutex<Option<SerialLog>>,
}

impl SerialTransport {
    /// 打开端口并接管。错误信息面向用户：端口被别的程序占着时要说清楚。
    pub fn open(
        config: SerialConfig,
        session_id: &str,
        log_dir: Option<&Path>,
    ) -> Result<Self, String> {
        config.validate().map_err(|err| err.to_string())?;
        let port = open_port(&config)?;
        let log = log_dir.and_then(|dir| match SerialLog::open(dir, &config, session_id) {
            Ok(log) => Some(log),
            Err(err) => {
                eprintln!("[serial] 日志文件没建起来：{err}");
                None
            }
        });
        Ok(Self {
            config: Mutex::new(config),
            port: Mutex::new(Some(port)),
            stop: Arc::new(AtomicBool::new(false)),
            status: Mutex::new(TransportStatus::Open),
            last_error: Mutex::new(None),
            log: Mutex::new(log),
        })
    }

    fn with_error(&self, message: String) -> String {
        *self.status.lock() = TransportStatus::Failed;
        *self.last_error.lock() = Some(message.clone());
        message
    }
}

impl Transport for SerialTransport {
    fn kind(&self) -> TransportKind {
        TransportKind::Serial
    }

    fn capabilities(&self) -> Capabilities {
        capabilities(TransportKind::Serial)
    }

    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut guard = self.port.lock();
        let Some(port) = guard.as_mut() else {
            return Err("端口已释放，先「连接」再发送".into());
        };
        port.write_all(bytes)
            .and_then(|_| port.flush())
            .map_err(|err| self.with_error(format!("写串口失败：{err}")))?;
        if let Some(log) = self.log.lock().as_ref() {
            log.record("TX", bytes);
        }
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
        Ok(())
    }

    fn release(&self) -> Result<(), String> {
        // 先让读线程退出（它可能在 read 里等超时），再丢写句柄。
        // 调用方负责 join 读线程；这里只发信号与丢句柄。
        self.stop.store(true, Ordering::Relaxed);
        let dropped = self.port.lock().take();
        drop(dropped);
        *self.status.lock() = TransportStatus::Released;
        *self.last_error.lock() = None;
        if let Some(log) = self.log.lock().as_ref() {
            log.record_note("释放端口（句柄已关闭）");
        }
        Ok(())
    }

    fn reopen(&self) -> Result<(), String> {
        // 「已释放」与「失败」都要真重开：读写出错后手里那个句柄已经不可信，
        // 只把状态改回 Open 会让用户以为连上了，实际一个字也发不出去。
        if *self.status.lock() == TransportStatus::Open && self.port.lock().is_some() {
            return Ok(());
        }
        // 先让旧读线程退出：读端可能还在 read 里等超时，也可能已经报错退出
        self.stop.store(true, Ordering::Relaxed);
        let stale = self.port.lock().take();
        drop(stale);
        let config = self.config.lock().clone();
        match open_port(&config) {
            Ok(port) => {
                self.stop.store(false, Ordering::Relaxed);
                *self.port.lock() = Some(port);
                *self.status.lock() = TransportStatus::Open;
                *self.last_error.lock() = None;
                if let Some(log) = self.log.lock().as_ref() {
                    log.record_note(&format!("重新打开 {}", config.port.trim()));
                }
                Ok(())
            }
            Err(err) => Err(self.with_error(err)),
        }
    }

    fn close(&self) -> Result<(), String> {
        self.stop.store(true, Ordering::Relaxed);
        let dropped = self.port.lock().take();
        drop(dropped);
        *self.status.lock() = TransportStatus::Released;
        if let Some(mut log) = self.log.lock().take() {
            log.close();
        }
        Ok(())
    }

    fn take_reader(&self) -> Result<Box<dyn Read + Send>, String> {
        let guard = self.port.lock();
        let Some(port) = guard.as_ref() else {
            return Err("端口已释放".into());
        };
        let clone = port
            .try_clone()
            .map_err(|err| format!("复制串口句柄失败：{err}"))?;
        Ok(Box::new(SerialReader {
            port: clone,
            stop: self.stop.clone(),
        }))
    }

    fn status(&self) -> TransportStatus {
        *self.status.lock()
    }

    fn last_error(&self) -> Option<String> {
        self.last_error.lock().clone()
    }

    fn port_key(&self) -> Option<String> {
        Some(self.config.lock().port.trim().to_string())
    }

    fn serial_config(&self) -> Option<SerialConfig> {
        Some(self.config.lock().clone())
    }

    fn log_path(&self) -> Option<PathBuf> {
        self.log.lock().as_ref().map(SerialLog::path)
    }

    fn log_rx(&self, bytes: &[u8]) {
        if let Some(log) = self.log.lock().as_ref() {
            log.record("RX", bytes);
        }
    }

    /// 读线程的错误只改状态，不在这里关句柄：读写失败通常意味着设备已拔，
    /// 会话保持热的，由用户决定「重连」还是「关闭」。
    fn note_failure(&self, message: &str) {
        self.with_error(message.to_string());
        if let Some(log) = self.log.lock().as_ref() {
            log.record_note(&format!("读失败：{message}"));
        }
    }
}

fn open_port(config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort + Send>, String> {
    let port_name = config.port.trim();
    let mut builder = serialport::new(port_name, config.baud)
        .data_bits(match config.data_bits {
            DataBits::Five => serialport::DataBits::Five,
            DataBits::Six => serialport::DataBits::Six,
            DataBits::Seven => serialport::DataBits::Seven,
            DataBits::Eight => serialport::DataBits::Eight,
        })
        .parity(match config.parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        })
        .stop_bits(match config.stop_bits {
            StopBits::One => serialport::StopBits::One,
            StopBits::Two => serialport::StopBits::Two,
        })
        .flow_control(match config.flow {
            FlowControl::None => serialport::FlowControl::None,
            FlowControl::Software => serialport::FlowControl::Software,
            FlowControl::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(Duration::from_millis(SERIAL_READ_TIMEOUT_MS));
    // 打开时把 DTR/RTS 拉到用户选的电平
    builder = builder.dtr_on_open(config.dtr);

    let mut port = builder.open().map_err(|err| open_error(port_name, err))?;
    if let Err(err) = port.write_request_to_send(config.rts) {
        // 虚拟串口对与部分芯片不支持改 RTS：记一笔，不让整个会话打不开
        eprintln!("[serial] 设置 RTS 失败：{err}");
    }
    Ok(port)
}

fn open_error(port: &str, err: serialport::Error) -> String {
    let message = err.description.clone();
    match err.kind() {
        serialport::ErrorKind::NoDevice => format!(
            "打不开 {port}：端口不存在，或者已被其他程序（含本应用的另一个会话）占用。关闭占用它的程序后重试。"
        ),
        _ => format!("打不开 {port}：{message}"),
    }
}

// ---------- 串口日志 ----------

/// 日志按原始字节记：可打印字符原样，控制与高位字节写成 `\r` / `\n` / `\xNN`。
/// 这样既能直接读，又不会让二进制里的换行把一条记录拆成两行。
pub struct SerialLog {
    path: PathBuf,
    file: Option<File>,
    start: Instant,
}

impl SerialLog {
    pub fn open(dir: &Path, config: &SerialConfig, session_id: &str) -> io::Result<Self> {
        let logs = dir.join("logs");
        fs::create_dir_all(&logs)?;
        let stamp = utc_stamp(SystemTime::now());
        let path = logs.join(log_file_name(&config.port, &stamp, session_id));
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        let _ = writeln!(file, "# PinShell 串口日志");
        let _ = writeln!(
            file,
            "# port={} baud={} data={} parity={} stop={} flow={} dtr={} rts={}",
            config.port.trim(),
            config.baud,
            config.data_bits.value(),
            config.parity.as_str(),
            config.stop_bits.as_str(),
            config.flow.as_str(),
            config.dtr,
            config.rts
        );
        let _ = writeln!(file, "# session={session_id}");
        let _ = file.flush();
        Ok(Self {
            path,
            file: Some(file),
            start: Instant::now(),
        })
    }

    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    fn record(&self, dir: &str, bytes: &[u8]) {
        let Some(file) = self.file.as_ref() else {
            return;
        };
        let mut file = file;
        let _ = writeln!(
            file,
            "[{dir} +{}ms] {}",
            self.start.elapsed().as_millis(),
            escape_for_log(bytes)
        );
    }

    fn record_note(&self, note: &str) {
        let Some(file) = self.file.as_ref() else {
            return;
        };
        let mut file = file;
        let _ = writeln!(file, "[-- +{}ms] {note}", self.start.elapsed().as_millis());
    }

    fn close(&mut self) {
        if let Some(mut file) = self.file.take() {
            let _ = file.flush();
        }
    }
}

impl Drop for SerialLog {
    fn drop(&mut self) {
        self.close();
    }
}

/// 日志文件名里的 UTC 时间戳：`20261118-114500`。不引时间库，自己算格里高利历。
fn utc_stamp(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 `civil_from_days`：1970-01-01 起的天数 → 年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

// ---------- 假 Transport（内存管道） ----------

/// 内存里的「串口」：写进来的字节落在 `sent` 里，`inject` 的字节从读端出去。
///
/// 用途有两个：
/// 1. 测试不需要 com0com 之类的驱动（见 `docs/testing.md` §4）；
/// 2. 开发时用 `PINSHELL_FAKE_SERIAL=1` 起一个回环会话，没接硬件也能验界面。
pub mod fake {
    use super::*;

    /// 假串口在列表里的端口名。只在 `PINSHELL_FAKE_SERIAL=1` 时出现；
    /// 打开它不会碰系统端口，写什么回什么。
    pub const FAKE_PORT: &str = "PINSHELL_LOOP";

    struct Inner {
        state: Mutex<FakeState>,
        ready: Condvar,
    }

    struct FakeState {
        to_host: VecDeque<u8>,
        from_host: Vec<u8>,
        released: bool,
        echo: bool,
    }

    /// 测试或开发侧拿到的另一端。
    #[derive(Clone)]
    pub struct FakePeer {
        inner: Arc<Inner>,
    }

    #[allow(dead_code)] // `sent` / `set_echo` 留给开发期回环与后续测试
    impl FakePeer {
        /// 模拟设备发来一段字节。
        pub fn inject(&self, bytes: &[u8]) {
            let mut state = self.inner.state.lock();
            state.to_host.extend(bytes.iter().copied());
            self.inner.ready.notify_all();
        }

        /// 应用写出去的全部字节（不清空）。
        pub fn sent(&self) -> Vec<u8> {
            self.inner.state.lock().from_host.clone()
        }

        pub fn take_sent(&self) -> Vec<u8> {
            std::mem::take(&mut self.inner.state.lock().from_host)
        }

        pub fn released(&self) -> bool {
            self.inner.state.lock().released
        }

        pub fn set_echo(&self, echo: bool) {
            self.inner.state.lock().echo = echo;
        }
    }

    pub struct MemoryTransport {
        inner: Arc<Inner>,
        config: SerialConfig,
    }

    impl MemoryTransport {
        /// 造一对「应用 ↔ 设备」。回环为真时，写进来的字节会立刻原样读回去。
        pub fn pair(config: SerialConfig, echo: bool) -> (Self, FakePeer) {
            let inner = Arc::new(Inner {
                state: Mutex::new(FakeState {
                    to_host: VecDeque::new(),
                    from_host: Vec::new(),
                    released: false,
                    echo,
                }),
                ready: Condvar::new(),
            });
            (
                Self {
                    inner: inner.clone(),
                    config,
                },
                FakePeer { inner },
            )
        }

        /// 开发用回环：打开时先吐一行欢迎语，之后写什么回什么。
        pub fn loopback(config: SerialConfig) -> (Self, FakePeer) {
            let (transport, peer) = Self::pair(config.clone(), true);
            peer.inject(
                format!(
                    "PinShell 假串口 {} · {} · 输入的内容会原样回显\r\n",
                    config.port.trim(),
                    config.summary()
                )
                .as_bytes(),
            );
            (transport, peer)
        }
    }

    impl Transport for MemoryTransport {
        fn kind(&self) -> TransportKind {
            TransportKind::Serial
        }

        fn capabilities(&self) -> Capabilities {
            capabilities(TransportKind::Serial)
        }

        fn write(&self, bytes: &[u8]) -> Result<(), String> {
            let mut state = self.inner.state.lock();
            if state.released {
                return Err("端口已释放，先「连接」再发送".into());
            }
            state.from_host.extend_from_slice(bytes);
            if state.echo {
                state.to_host.extend(bytes.iter().copied());
            }
            drop(state);
            self.inner.ready.notify_all();
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }

        fn release(&self) -> Result<(), String> {
            let mut state = self.inner.state.lock();
            state.released = true;
            drop(state);
            self.inner.ready.notify_all();
            Ok(())
        }

        fn reopen(&self) -> Result<(), String> {
            let mut state = self.inner.state.lock();
            state.released = false;
            drop(state);
            self.inner.ready.notify_all();
            Ok(())
        }

        fn close(&self) -> Result<(), String> {
            self.release()
        }

        fn take_reader(&self) -> Result<Box<dyn Read + Send>, String> {
            if self.inner.state.lock().released {
                return Err("端口已释放".into());
            }
            Ok(Box::new(MemoryReader {
                inner: self.inner.clone(),
            }))
        }

        fn status(&self) -> TransportStatus {
            if self.inner.state.lock().released {
                TransportStatus::Released
            } else {
                TransportStatus::Open
            }
        }

        fn last_error(&self) -> Option<String> {
            None
        }

        fn port_key(&self) -> Option<String> {
            Some(self.config.port.trim().to_string())
        }

        fn serial_config(&self) -> Option<SerialConfig> {
            Some(self.config.clone())
        }
    }

    struct MemoryReader {
        inner: Arc<Inner>,
    }

    impl Read for MemoryReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut state = self.inner.state.lock();
            loop {
                if !state.to_host.is_empty() {
                    let count = buf.len().min(state.to_host.len());
                    for slot in buf.iter_mut().take(count) {
                        *slot = state.to_host.pop_front().unwrap();
                    }
                    return Ok(count);
                }
                if state.released {
                    return Ok(0);
                }
                self.inner
                    .ready
                    .wait_for(&mut state, Duration::from_millis(20));
            }
        }
    }
}

/// 串口枚举的一行。`kind` 是 USB / PCI / 蓝牙 / 未知，供界面打标签。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortInfo {
    pub port: String,
    pub kind: &'static str,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub friendly_name: Option<String>,
}

pub fn available_ports() -> Vec<PortInfo> {
    let friendly_names = windows_port_friendly_names();
    let mut list: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|info| {
            let port = info.port_name;
            let friendly_name = friendly_names.get(&port.to_ascii_uppercase()).cloned();
            let (kind, vid, pid, manufacturer, product, serial_number) = match info.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    "usb",
                    Some(usb.vid),
                    Some(usb.pid),
                    usb.manufacturer,
                    usb.product,
                    usb.serial_number,
                ),
                serialport::SerialPortType::PciPort => ("pci", None, None, None, None, None),
                serialport::SerialPortType::BluetoothPort => {
                    ("bluetooth", None, None, None, None, None)
                }
                serialport::SerialPortType::Unknown => ("unknown", None, None, None, None, None),
            };
            PortInfo {
                port,
                kind,
                vid,
                pid,
                manufacturer,
                product,
                serial_number,
                friendly_name,
            }
        })
        .collect();
    list.sort_by(|a, b| natural_port_order(&a.port, &b.port));
    // 开发/演示用：没有硬件也能把串口界面走通，并且完全不碰系统端口
    if fake_serial_enabled() {
        list.insert(
            0,
            PortInfo {
                port: fake::FAKE_PORT.to_string(),
                kind: "virtual",
                vid: None,
                pid: None,
                manufacturer: Some("PinShell".into()),
                product: Some("假串口（回环，仅调试）".into()),
                serial_number: None,
                friendly_name: None,
            },
        );
    }
    list
}

#[cfg(windows)]
fn windows_port_friendly_names() -> std::collections::HashMap<String, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SPDRP_FRIENDLYNAME,
        SP_DEVINFO_DATA,
    };
    struct DeviceInfoSet(windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO);
    impl Drop for DeviceInfoSet {
        fn drop(&mut self) {
            let _ = unsafe { SetupDiDestroyDeviceInfoList(self.0) };
        }
    }
    let mut names = std::collections::HashMap::new();
    let Ok(devices) = (unsafe {
        SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_ALLCLASSES | DIGCF_PRESENT)
    }) else {
        return names;
    };
    let devices = DeviceInfoSet(devices);
    let devices = devices.0;
    let mut index = 0;
    loop {
        let mut device = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if unsafe { SetupDiEnumDeviceInfo(devices, index, &mut device) }.is_err() {
            break;
        }
        index += 1;
        let mut buffer = [0u8; 2048];
        if unsafe {
            SetupDiGetDeviceRegistryPropertyW(
                devices,
                &device,
                SPDRP_FRIENDLYNAME,
                None,
                Some(&mut buffer),
                None,
            )
        }
        .is_err()
        {
            continue;
        }
        let wide =
            unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u16>(), buffer.len() / 2) };
        let end = wide
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(wide.len());
        let Ok(name) = String::from_utf16(&wide[..end]) else {
            continue;
        };
        let Some(start) = name.rfind("(COM") else {
            continue;
        };
        let Some(end) = name[start..].find(')') else {
            continue;
        };
        let port = name[start + 1..start + end].to_ascii_uppercase();
        if port.len() > 3 && port[3..].chars().all(|ch| ch.is_ascii_digit()) {
            names.insert(port, name);
        }
    }
    names
}

#[cfg(not(windows))]
fn windows_port_friendly_names() -> std::collections::HashMap<String, String> {
    std::collections::HashMap::new()
}

/// `COM2` 排在 `COM10` 前面（按数字比，不按字符串比）。
fn natural_port_order(a: &str, b: &str) -> std::cmp::Ordering {
    let num = |text: &str| {
        text.chars()
            .filter(|ch| ch.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .ok()
    };
    match (num(a), num(b)) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.cmp(b)),
        _ => a.cmp(b),
    }
}

/// 假串口只在显式打开开关时出现，避免正常用户看到一条假设备。
pub fn fake_serial_enabled() -> bool {
    std::env::var("PINSHELL_FAKE_SERIAL")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[allow(dead_code)] // 只在开发期回环与测试里用
pub fn fake_serial_config() -> SerialConfig {
    SerialConfig::new(fake::FAKE_PORT)
}

/// 打包用的小工具：把一串字节转成 HEX 给界面确认（测试也用得上）。
#[allow(dead_code)]
pub fn hex_preview(bytes: &[u8], limit: usize) -> String {
    let head = &bytes[..bytes.len().min(limit)];
    let mut text = format_hex(head);
    if bytes.len() > head.len() {
        text.push_str(" …");
    }
    text
}

/// 行的结束符只是透传，这里保留一个显式依赖，提醒调用方组包规则在 core-domain。
#[allow(dead_code)]
pub fn line_ending_bytes(ending: LineEnding) -> &'static [u8] {
    ending.bytes()
}

/// 发送方式同样只在 core-domain 定义一次。
#[allow(dead_code)]
pub fn send_mode_label(mode: SendMode) -> &'static str {
    match mode {
        SendMode::Direct => "直发",
        SendMode::Line => "行缓冲",
    }
}

#[cfg(test)]
mod tests {
    use super::fake::MemoryTransport;
    use super::*;
    use std::io::Read;

    fn config() -> SerialConfig {
        SerialConfig::new("COM_TEST")
    }

    #[test]
    fn fake_transport_is_a_serial_channel_with_the_documented_capabilities() {
        let (transport, _peer) = MemoryTransport::pair(config(), false);
        assert_eq!(transport.kind(), TransportKind::Serial);
        let caps = transport.capabilities();
        assert!(!caps.completion && !caps.history && caps.timestamp && !caps.alt_screen);
        assert_eq!(transport.port_key().as_deref(), Some("COM_TEST"));
        assert_eq!(transport.status(), TransportStatus::Open);
        assert_eq!(
            transport.serial_config().map(|c| c.port),
            Some("COM_TEST".to_string())
        );
    }

    #[test]
    fn written_bytes_go_to_the_peer_and_injected_bytes_come_out_of_the_reader() {
        let (transport, peer) = MemoryTransport::pair(config(), false);
        transport.write(b"AT\r\n").unwrap();
        assert_eq!(peer.take_sent(), b"AT\r\n");

        peer.inject(b"OK\r\n");
        let mut reader = transport.take_reader().unwrap();
        let mut buf = [0u8; 16];
        let n = reader.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"OK\r\n");
    }

    #[test]
    fn release_ends_the_reader_and_reopen_starts_a_new_one() {
        let (transport, peer) = MemoryTransport::pair(config(), false);
        let mut reader = transport.take_reader().unwrap();

        transport.release().unwrap();
        assert_eq!(transport.status(), TransportStatus::Released);
        assert!(peer.released());
        let mut buf = [0u8; 4];
        assert_eq!(reader.read(&mut buf).unwrap(), 0, "释放后读端必须结束");
        assert!(transport.write(b"x").is_err(), "释放后写入要报错");
        assert!(transport.take_reader().is_err());

        transport.reopen().unwrap();
        assert_eq!(transport.status(), TransportStatus::Open);
        assert!(!peer.released());
        transport.write(b"back").unwrap();
        assert_eq!(peer.take_sent(), b"back");
        let mut reader = transport.take_reader().unwrap();
        peer.inject(b"hi");
        let n = reader.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"hi");
    }

    #[test]
    fn loopback_echoes_so_the_ui_can_be_exercised_without_hardware() {
        let (transport, _peer) = MemoryTransport::loopback(config());
        let mut reader = transport.take_reader().unwrap();
        let mut buf = [0u8; 256];
        let n = reader.read(&mut buf).unwrap();
        let banner = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(banner.contains("假串口"), "banner: {banner}");

        transport.write(b"ping\r\n").unwrap();
        let n = reader.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"ping\r\n");
    }

    #[test]
    fn port_order_is_numeric_not_lexicographic() {
        let mut ports = vec!["COM10", "COM2", "COM1"];
        ports.sort_by(|a, b| natural_port_order(a, b));
        assert_eq!(ports, vec!["COM1", "COM2", "COM10"]);
    }

    #[test]
    fn log_name_timestamp_is_utc_and_zero_padded() {
        let time = UNIX_EPOCH + Duration::from_secs(1_764_000_000);
        let stamp = utc_stamp(time);
        assert_eq!(stamp.len(), 15, "stamp: {stamp}");
        assert_eq!(&stamp[8..9], "-");
        assert!(
            stamp.starts_with("2025") || stamp.starts_with("2026"),
            "{stamp}"
        );
    }

    #[test]
    fn serial_log_records_directions_and_escapes_binary() {
        let dir = std::env::temp_dir().join(format!(
            "pinshell-log-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let log = SerialLog::open(&dir, &config(), "abcd1234").unwrap();
        log.record("RX", b"OK\r\n");
        log.record("TX", &[0x00, 0xff]);
        let path = log.path();
        drop(log);

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# PinShell 串口日志"));
        assert!(text.contains("port=COM_TEST"));
        assert!(text.contains("[RX +"));
        assert!(text.contains("OK\\r\\n"));
        assert!(text.contains("\\x00\\xFF"));
        assert!(text.contains("[TX +"));
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("serial-COM_TEST-"));
        assert!(name.ends_with("-abcd1234.log"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_enumeration_does_not_panic_and_skips_nothing_needed() {
        // 没有硬件的机器上这里只会是空列表；关键是它不 panic、不阻塞
        let ports = available_ports();
        for port in &ports {
            assert!(!port.port.is_empty());
            assert!(["usb", "pci", "bluetooth", "unknown", "virtual"].contains(&port.kind));
        }
    }

    #[test]
    fn hex_preview_truncates_with_an_ellipsis() {
        assert_eq!(hex_preview(&[0x41, 0x42], 8), "41 42");
        assert_eq!(hex_preview(&[0x41, 0x42, 0x43], 2), "41 42 …");
    }

    #[test]
    fn send_mode_labels_are_short_and_chinese() {
        assert_eq!(send_mode_label(SendMode::Direct), "直发");
        assert_eq!(send_mode_label(SendMode::Line), "行缓冲");
        assert_eq!(line_ending_bytes(LineEnding::Lf), b"\n");
    }
}
