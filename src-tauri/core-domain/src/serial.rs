//! 串口通道的纯规则：连接参数、HEX 解析、行结束符、发送组包、能力位与日志命名。
//!
//! 这里只有内存里的数据与规则，不碰端口、不碰文件、不碰时钟（时间由调用方传入），
//! 与 ADR 0001「会话是通道」一致：串口与终端共用会话模型，差异全部收敛在这个模块。
//!
//! 两条不可混淆的「暂停」：
//! - **输出暂停**是显示层开关，与通道无关；
//! - **串口暂停**（本模块之外的 `Paused` 状态）会真正关闭端口句柄，
//!   恢复时按同一份配置重新打开。同一个端口不允许两个热会话（I4）。

use crate::ownership::TransportKind;
use crate::workspace::MAX_TITLE_CHARS;
use std::fmt;

/// 数据位个数。串口硬件只认 5–8。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

impl DataBits {
    pub fn value(self) -> u8 {
        match self {
            DataBits::Five => 5,
            DataBits::Six => 6,
            DataBits::Seven => 7,
            DataBits::Eight => 8,
        }
    }

    pub fn from_value(bits: u8) -> Option<Self> {
        match bits {
            5 => Some(DataBits::Five),
            6 => Some(DataBits::Six),
            7 => Some(DataBits::Seven),
            8 => Some(DataBits::Eight),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parity {
    None,
    Odd,
    Even,
}

impl Parity {
    pub fn as_str(self) -> &'static str {
        match self {
            Parity::None => "none",
            Parity::Odd => "odd",
            Parity::Even => "even",
        }
    }

    pub fn from_str(text: &str) -> Option<Self> {
        match text {
            "none" => Some(Parity::None),
            "odd" => Some(Parity::Odd),
            "even" => Some(Parity::Even),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopBits {
    One,
    Two,
}

impl StopBits {
    pub fn as_str(self) -> &'static str {
        match self {
            StopBits::One => "one",
            StopBits::Two => "two",
        }
    }

    pub fn from_str(text: &str) -> Option<Self> {
        match text {
            "one" | "1" => Some(StopBits::One),
            "two" | "2" => Some(StopBits::Two),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowControl {
    None,
    Software,
    Hardware,
}

impl FlowControl {
    pub fn as_str(self) -> &'static str {
        match self {
            FlowControl::None => "none",
            FlowControl::Software => "software",
            FlowControl::Hardware => "hardware",
        }
    }

    pub fn from_str(text: &str) -> Option<Self> {
        match text {
            "none" => Some(FlowControl::None),
            "software" => Some(FlowControl::Software),
            "hardware" => Some(FlowControl::Hardware),
            _ => None,
        }
    }
}

/// 发送时附加的行结束符。终端固定 `\r`（见 L0-12），串口按这个设置取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Crlf,
    Cr,
    Lf,
}

impl LineEnding {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            LineEnding::Crlf => b"\r\n",
            LineEnding::Cr => b"\r",
            LineEnding::Lf => b"\n",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Crlf => "crlf",
            LineEnding::Cr => "cr",
            LineEnding::Lf => "lf",
        }
    }

    pub fn from_str(text: &str) -> Option<Self> {
        match text {
            "crlf" => Some(LineEnding::Crlf),
            "cr" => Some(LineEnding::Cr),
            "lf" => Some(LineEnding::Lf),
            _ => None,
        }
    }

    /// 给界面看的短标签：`\r\n` / `\r` / `\n`。
    pub fn label(self) -> &'static str {
        match self {
            LineEnding::Crlf => "CRLF",
            LineEnding::Cr => "CR",
            LineEnding::Lf => "LF",
        }
    }
}

/// 串口输入方式（设置项，不是会话类型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendMode {
    /// 直发：输入条里敲什么就写什么，不追加行结束符
    Direct,
    /// 行缓冲：按一行发送，末尾追加该会话的行结束符
    Line,
}

impl SendMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SendMode::Direct => "direct",
            SendMode::Line => "line",
        }
    }

    pub fn from_str(text: &str) -> Option<Self> {
        match text {
            "direct" => Some(SendMode::Direct),
            "line" => Some(SendMode::Line),
            _ => None,
        }
    }
}

/// 一个串口会话的连接参数与发送偏好。整份随工作区落盘，冷会话重开时按它重连。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerialConfig {
    pub port: String,
    pub baud: u32,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow: FlowControl,
    /// 打开端口后是否拉高 DTR / RTS
    pub dtr: bool,
    pub rts: bool,
    pub line_ending: LineEnding,
    pub send_mode: SendMode,
}

impl SerialConfig {
    /// 最常用的 115200 8N1、无流控。DTR/RTS 默认拉高：多数 USB 转串口模块
    /// 需要它们才有正常的电平，而虚拟串口对不受影响。
    pub fn new(port: impl Into<String>) -> Self {
        Self {
            port: port.into(),
            baud: 115_200,
            data_bits: DataBits::Eight,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow: FlowControl::None,
            dtr: true,
            rts: true,
            line_ending: LineEnding::Crlf,
            send_mode: SendMode::Line,
        }
    }

    pub fn validate(&self) -> Result<(), SerialConfigError> {
        let port = self.port.trim();
        if port.is_empty() {
            return Err(SerialConfigError::EmptyPort);
        }
        if port.chars().count() > MAX_PORT_CHARS {
            return Err(SerialConfigError::PortTooLong);
        }
        if !(MIN_BAUD..=MAX_BAUD).contains(&self.baud) {
            return Err(SerialConfigError::InvalidBaud(self.baud));
        }
        Ok(())
    }

    /// 新会话的默认标题：`COM3 · 115200`，按字符截断（与改名规则同一条上限）。
    pub fn default_title(&self) -> String {
        let raw = format!("{} · {}", self.port.trim(), self.baud);
        raw.chars().take(MAX_TITLE_CHARS).collect()
    }

    /// 一句话摘要，给状态栏与 tooltip 用。
    pub fn summary(&self) -> String {
        format!(
            "{} {}{}{} {}",
            self.baud,
            self.data_bits.value(),
            match self.parity {
                Parity::None => "N",
                Parity::Odd => "O",
                Parity::Even => "E",
            },
            match self.stop_bits {
                StopBits::One => "1",
                StopBits::Two => "2",
            },
            match self.flow {
                FlowControl::None => "",
                FlowControl::Software => "XON/XOFF",
                FlowControl::Hardware => "RTS/CTS",
            }
        )
        .trim_end()
        .to_string()
    }
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self::new("")
    }
}

/// 端口名的长度上限。Windows 的 `COMx` 远小于它，这里只是拦住粘贴进来的整段日志。
pub const MAX_PORT_CHARS: usize = 64;
pub const MIN_BAUD: u32 = 50;
pub const MAX_BAUD: u32 = 4_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SerialConfigError {
    EmptyPort,
    PortTooLong,
    InvalidBaud(u32),
}

impl fmt::Display for SerialConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SerialConfigError::EmptyPort => write!(f, "端口名不能为空"),
            SerialConfigError::PortTooLong => {
                write!(f, "端口名太长（最多 {MAX_PORT_CHARS} 个字符）")
            }
            SerialConfigError::InvalidBaud(baud) => {
                write!(f, "波特率 {baud} 超出 {MIN_BAUD}–{MAX_BAUD}")
            }
        }
    }
}

/// 能力位。界面按它隐藏入口，而不是按会话类型分支判断（ADR 0001）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    /// 补全与 Ghost Text
    pub completion: bool,
    /// 命令历史与 Ctrl+R 检索
    pub history: bool,
    /// 时间戳锚点
    pub timestamp: bool,
    /// 备用屏状态（全屏程序）
    pub alt_screen: bool,
}

pub const fn capabilities(kind: TransportKind) -> Capabilities {
    match kind {
        TransportKind::Terminal => Capabilities {
            completion: true,
            history: true,
            timestamp: true,
            alt_screen: true,
        },
        // 串口没有 shell，也就没有「命令」：关掉补全、Ghost Text、检索与备用屏。
        // 发送历史与时间戳保留（前者走 ↑↓，后者是显示层）。
        TransportKind::Serial => Capabilities {
            completion: false,
            history: false,
            timestamp: true,
            alt_screen: false,
        },
    }
}

// ---------- HEX（L0-10） ----------

/// 哪些字符可以当分隔符：空白、逗号、分号。`0x` 前缀不认——`x` 会按非法字符报出来，
/// 比悄悄接受再猜一位更清楚。
fn is_hex_separator(ch: char) -> bool {
    ch.is_ascii_whitespace() || ch == ',' || ch == ';'
}

/// 解析用户输入的 HEX。拒绝原因各自明确，界面可以直接显示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HexError {
    /// 只有分隔符（或什么都没有）
    Empty,
    /// 十六进制位数是奇数：`ABC`
    OddDigits,
    /// 不是十六进制数字。`index` 是字符位置（从 0 数，含分隔符）
    InvalidChar { ch: char, index: usize },
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HexError::Empty => write!(f, "没有可发送的字节"),
            HexError::OddDigits => write!(f, "十六进制位数是奇数，每字节需要两位"),
            HexError::InvalidChar { ch, index } => {
                write!(f, "第 {} 个字符 {ch:?} 不是十六进制数字", index + 1)
            }
        }
    }
}

/// 把 HEX 文本解析成字节。空格、逗号、分号与换行都当分隔符，大小写不敏感。
pub fn parse_hex(text: &str) -> Result<Vec<u8>, HexError> {
    let mut digits: Vec<u8> = Vec::with_capacity(text.len());
    for (index, ch) in text.chars().enumerate() {
        if is_hex_separator(ch) {
            continue;
        }
        let Some(value) = ch.to_digit(16) else {
            return Err(HexError::InvalidChar { ch, index });
        };
        digits.push(value as u8);
    }
    if digits.is_empty() {
        return Err(HexError::Empty);
    }
    if digits.len() % 2 != 0 {
        return Err(HexError::OddDigits);
    }
    Ok(digits
        .chunks_exact(2)
        .map(|pair| (pair[0] << 4) | pair[1])
        .collect())
}

/// 字节转 HEX：大写、单空格分隔、无尾随空格。`parse_hex(format_hex(x)) == x`。
pub fn format_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(3));
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push(digit_char(byte >> 4));
        out.push(digit_char(byte & 0x0f));
    }
    out
}

fn digit_char(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + value - 10) as char,
    }
}

// ---------- 发送组包（L0-12） ----------

/// 一次发送的组包结果。`bytes` 就是写进通道的内容。
///
/// 规则：
/// - HEX 一律按整行组包：解析成字节后原样写出，**不追加行结束符**；
/// - 行缓冲：文本 + 该会话的行结束符；
/// - 直发：只有文本本身。
pub fn build_payload(
    text: &str,
    send_mode: SendMode,
    line_ending: LineEnding,
    hex: bool,
) -> Result<Vec<u8>, HexError> {
    if hex {
        return parse_hex(text);
    }
    let mut bytes = text.as_bytes().to_vec();
    if send_mode == SendMode::Line {
        bytes.extend_from_slice(line_ending.bytes());
    }
    Ok(bytes)
}

/// 端口名比较：Windows 的 `COM3` 与 `com3` 是同一个端口，I4 不能放过它。
pub fn same_port(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// I4：同一个串口不允许两个热会话。
///
/// `ports` 是一组 `(会话 id, 端口名)`；返回第一个占用 `port` 的其他会话。
/// 「暂停」不改变会话是热的，所以已释放端口的会话仍会占住这个名额——
/// 让出去是给别的程序用的，不是给本应用的第二个会话用的。
pub fn conflicting_session<'a, I>(ports: I, port: &str, except: &str) -> Option<&'a str>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    ports.into_iter().find_map(|(id, key)| {
        if id == except {
            return None;
        }
        same_port(key, port).then_some(id)
    })
}

// ---------- 日志 ----------

/// 日志里的一行长这样：可打印字节原样，控制与高位字节转 `\r` / `\n` / `\xNN`。
/// 既有可读性，又不会让二进制里的换行把一条记录拆成两行。
pub fn escape_for_log(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &byte in bytes {
        match byte {
            b'\r' => out.push_str("\\r"),
            b'\n' => out.push_str("\\n"),
            b'\t' => out.push_str("\\t"),
            b'\\' => out.push_str("\\\\"),
            0x20..=0x7e => out.push(byte as char),
            _ => {
                out.push_str("\\x");
                out.push(digit_char(byte >> 4));
                out.push(digit_char(byte & 0x0f));
            }
        }
    }
    out
}

/// 日志文件名：`serial-COM3-20261118-114500-1a2b3c4d.log`。
///
/// 端口名与时间戳都由调用方给，这里只做文件名安全化：只留字母、数字、`-`、`_`，
/// 其余一律换成 `_`，防止 `..` 或路径分隔符把文件写到数据目录外面。
pub fn log_file_name(port: &str, stamp: &str, session_id: &str) -> String {
    format!(
        "serial-{}-{}-{}.log",
        sanitize_component(port, "port"),
        sanitize_component(stamp, "time"),
        sanitize_component(&session_id.chars().take(8).collect::<String>(), "session")
    )
}

fn sanitize_component(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    while out.starts_with('_') {
        out.remove(0);
    }
    if out.is_empty() {
        out.push_str(fallback);
    }
    // 单个组件也不该长到让路径超限
    out.chars().take(64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- L0-10 HEX ----------

    #[test]
    fn hex_accepts_spaces_commas_and_mixed_case() {
        assert_eq!(parse_hex("48 65 6c 6C 6F").unwrap(), b"Hello");
        assert_eq!(parse_hex("48,65;6C\n6C\t6F").unwrap(), b"Hello");
        assert_eq!(parse_hex("  0A  ").unwrap(), vec![0x0a]);
        assert_eq!(parse_hex("ff").unwrap(), vec![0xff]);
    }

    #[test]
    fn hex_rejects_empty_odd_and_non_hex_with_reasons() {
        assert_eq!(parse_hex("   ").unwrap_err(), HexError::Empty);
        assert_eq!(parse_hex("ABC").unwrap_err(), HexError::OddDigits);
        assert_eq!(parse_hex("4").unwrap_err(), HexError::OddDigits);
        assert_eq!(
            parse_hex("48 4G").unwrap_err(),
            HexError::InvalidChar { ch: 'G', index: 4 }
        );
        // `0x48` 不认前缀：`x` 直接报非法字符，比猜一位更诚实
        assert_eq!(
            parse_hex("0x48").unwrap_err(),
            HexError::InvalidChar { ch: 'x', index: 1 }
        );
        // 中文不是十六进制数字，位置按字符数而不是字节数
        assert_eq!(
            parse_hex("48 中").unwrap_err(),
            HexError::InvalidChar {
                ch: '中', index: 3
            }
        );
    }

    #[test]
    fn hex_round_trips_through_format() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        let text = format_hex(&bytes);
        assert_eq!(parse_hex(&text).unwrap(), bytes);
        assert!(text.starts_with("00 01 02"), "got {:?}", &text[..8]);
        assert!(text.ends_with("FE FF"));
        assert_eq!(format_hex(&[]), "");
        assert_eq!(format_hex(&[0x0a, 0xff]), "0A FF");
    }

    // ---------- L0-12 行结束符与组包 ----------

    #[test]
    fn line_endings_are_the_documented_bytes() {
        assert_eq!(LineEnding::Crlf.bytes(), b"\r\n");
        assert_eq!(LineEnding::Cr.bytes(), b"\r");
        assert_eq!(LineEnding::Lf.bytes(), b"\n");
        assert_eq!(LineEnding::Crlf.label(), "CRLF");
        assert_eq!(LineEnding::from_str("lf"), Some(LineEnding::Lf));
        assert_eq!(LineEnding::from_str("LF"), None);
    }

    #[test]
    fn line_mode_appends_the_session_ending_and_direct_does_not() {
        let text = "AT";
        assert_eq!(
            build_payload(text, SendMode::Line, LineEnding::Crlf, false).unwrap(),
            b"AT\r\n"
        );
        assert_eq!(
            build_payload(text, SendMode::Line, LineEnding::Cr, false).unwrap(),
            b"AT\r"
        );
        assert_eq!(
            build_payload(text, SendMode::Direct, LineEnding::Crlf, false).unwrap(),
            b"AT"
        );
    }

    #[test]
    fn hex_payload_never_gets_a_line_ending() {
        assert_eq!(
            build_payload("41 54", SendMode::Line, LineEnding::Crlf, true).unwrap(),
            b"AT"
        );
        assert_eq!(
            build_payload("41 5A", SendMode::Direct, LineEnding::Lf, true).unwrap(),
            b"AZ"
        );
        assert_eq!(
            build_payload("4", SendMode::Direct, LineEnding::Cr, true).unwrap_err(),
            HexError::OddDigits
        );
    }

    // ---------- 参数与能力位 ----------

    #[test]
    fn defaults_are_115200_8n1_with_both_handshake_lines_high() {
        let config = SerialConfig::new("COM3");
        assert_eq!(config.baud, 115_200);
        assert_eq!(config.data_bits, DataBits::Eight);
        assert_eq!(config.parity, Parity::None);
        assert_eq!(config.stop_bits, StopBits::One);
        assert_eq!(config.flow, FlowControl::None);
        assert!(config.dtr && config.rts);
        assert_eq!(config.line_ending, LineEnding::Crlf);
        assert_eq!(config.send_mode, SendMode::Line);
        config.validate().unwrap();
        assert_eq!(config.summary(), "115200 8N1");
        assert_eq!(config.default_title(), "COM3 · 115200");
    }

    #[test]
    fn config_rejects_blank_long_port_and_out_of_range_baud() {
        let mut config = SerialConfig::new("   ");
        assert_eq!(config.validate(), Err(SerialConfigError::EmptyPort));
        config.port = "X".repeat(MAX_PORT_CHARS + 1);
        assert_eq!(config.validate(), Err(SerialConfigError::PortTooLong));
        config.port = "COM3".into();
        config.baud = 0;
        assert_eq!(config.validate(), Err(SerialConfigError::InvalidBaud(0)));
        config.baud = MAX_BAUD + 1;
        assert_eq!(
            config.validate(),
            Err(SerialConfigError::InvalidBaud(MAX_BAUD + 1))
        );
        config.baud = MIN_BAUD;
        config.validate().unwrap();
    }

    #[test]
    fn title_is_trimmed_and_truncated_by_characters() {
        let mut config = SerialConfig::new("  COM12  ");
        config.baud = 9_600;
        assert_eq!(config.default_title(), "COM12 · 9600");
        config.port = "口".repeat(60);
        let title = config.default_title();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn capabilities_differ_only_where_the_documentation_says() {
        let terminal = capabilities(TransportKind::Terminal);
        let serial = capabilities(TransportKind::Serial);
        assert!(terminal.completion && terminal.history && terminal.alt_screen);
        assert!(!serial.completion && !serial.history && !serial.alt_screen);
        assert!(serial.timestamp, "时间戳对两种通道都保留");
    }

    #[test]
    fn port_comparison_ignores_case_and_padding() {
        assert!(same_port("COM3", "com3"));
        assert!(same_port(" COM3 ", "com3"));
        assert!(!same_port("COM3", "COM30"));
        assert!(!same_port("COM3", ""));
    }

    #[test]
    fn only_one_hot_session_per_port_but_released_ones_still_reserve_it() {
        let ports = [("a", "COM3"), ("b", "COM4")];
        assert_eq!(conflicting_session(ports, "com3", "b"), Some("a"));
        // 自己不算冲突：冷会话重开、页面重挂都会带着同一个 id
        assert_eq!(conflicting_session(ports, "COM3", "a"), None);
        assert_eq!(conflicting_session(ports, "COM9", "a"), None);
        // 空端口不该匹配任何会话
        assert_eq!(conflicting_session(ports, "  ", "a"), None);
    }

    // ---------- 日志 ----------

    #[test]
    fn log_escape_keeps_text_readable_and_marks_binary() {
        assert_eq!(escape_for_log(b"AT\r\nOK"), "AT\\r\\nOK");
        assert_eq!(escape_for_log(b"a\\b\t"), "a\\\\b\\t");
        assert_eq!(
            escape_for_log(&[0x00, 0x7f, 0x80, 0xff]),
            "\\x00\\x7F\\x80\\xFF"
        );
        // 中文按 UTF-8 字节逐个标注，日志不会被多字节字符撕开
        assert_eq!(escape_for_log("中".as_bytes()), "\\xE4\\xB8\\xAD");
    }

    #[test]
    fn log_name_is_safe_and_stable() {
        assert_eq!(
            log_file_name("COM3", "20261118-114500", "1a2b3c4d-0000"),
            "serial-COM3-20261118-114500-1a2b3c4d.log"
        );
        // 路径分隔符与 `..` 都不会逃出数据目录
        let name = log_file_name("..\\COM3/../../x", "t:1", "");
        assert!(!name.contains('/') && !name.contains('\\'));
        assert!(!name.contains(".."));
        assert!(name.starts_with("serial-"));
        assert!(name.ends_with(".log"));
        // 全空也给出可用的名字
        assert_eq!(log_file_name("", "", ""), "serial-port-time-session.log");
    }
}
