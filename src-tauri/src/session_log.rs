//! 会话用户日志。由调用方串行访问，并在收到文本时立即调用 `receive`。
//! 文件名占位符：%Y 年、%M 月、%D 日、%h 时、%m 分、%s 秒、%S 毫秒、%% 百分号。
//! 时间戳格式两种写法都认：默认的 Java 风格 `yyyy-MM-dd HH:mm:ss.SSS`
//! （`yyyy/MM/dd/HH/mm/ss/SSS` 等），以及含 `%` 的 chrono strftime。

use chrono::{
    format::{Item, StrftimeItems},
    Local,
};
use core_domain::workspace::SessionSettings;
use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Escape {
    Ground,
    Esc,
    Csi,
    String,
    StringEsc,
}

// 跟踪 CSI、OSC、DCS 等序列，确保分块时不会把前缀插进控制序列内部。
fn advance_escape(state: &mut Escape, c: char) -> bool {
    match *state {
        Escape::Ground if c == '\x1b' => {
            *state = Escape::Esc;
            true
        }
        Escape::Ground => false,
        Escape::Esc => {
            *state = match c {
                '[' => Escape::Csi,
                ']' | 'P' | 'X' | '^' | '_' => Escape::String,
                '\x20'..='\x2f' => Escape::Esc,
                _ => Escape::Ground,
            };
            true
        }
        Escape::Csi => {
            if ('\x40'..='\x7e').contains(&c) {
                *state = Escape::Ground;
            }
            true
        }
        Escape::String => {
            if c == '\x07' {
                *state = Escape::Ground;
            } else if c == '\x1b' {
                *state = Escape::StringEsc;
            }
            true
        }
        Escape::StringEsc => {
            *state = if c == '\\' {
                Escape::Ground
            } else if c == '\x1b' {
                Escape::StringEsc
            } else {
                Escape::String
            };
            true
        }
    }
}

struct LineState {
    start: bool,
    escape: Escape,
}
impl Default for LineState {
    fn default() -> Self {
        Self {
            start: true,
            escape: Escape::Ground,
        }
    }
}

impl LineState {
    fn render(&mut self, text: &str, timestamps: bool, format: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            if advance_escape(&mut self.escape, c) {
                out.push(c);
                continue;
            }
            if self.start && timestamps && (c == '\n' || !c.is_control()) {
                out.push('[');
                out.push_str(&Local::now().format(format).to_string());
                out.push_str("] ");
                self.start = false;
            }
            out.push(c);
            if c == '\n' {
                self.start = true;
            } else if !c.is_control() {
                self.start = false;
            }
        }
        out
    }
}

pub struct RuntimeLog {
    settings: SessionSettings,
    file: Option<File>,
    path: Option<PathBuf>,
    display: LineState,
    logged: LineState,
    serial_escape: Escape,
    serial_after_cr: bool,
    /// 暂停/继续（断开/连接）翻过页：下一条记录落到新文件。
    /// 不在切换那一刻立刻建文件，避免暂停期间留下一个空文件。
    rotate_pending: bool,
}

impl RuntimeLog {
    pub fn new(settings: SessionSettings) -> Result<Self, String> {
        validate(&settings)?;
        let (file, path) = if settings.logging {
            let (file, path) = open_log(&settings)?;
            (Some(file), Some(path))
        } else {
            (None, None)
        };
        Ok(Self {
            settings,
            file,
            path,
            display: LineState::default(),
            logged: LineState::default(),
            serial_escape: Escape::Ground,
            serial_after_cr: false,
            rotate_pending: false,
        })
    }

    /// 先创建新文件，再提交设置；创建失败时保留原有日志和设置。
    pub fn update(&mut self, settings: SessionSettings) -> Result<(), String> {
        validate(&settings)?;
        let rotate = settings.logging
            && (!self.settings.logging
                || self.file.is_none()
                || settings.log_directory != self.settings.log_directory
                || settings.log_filename != self.settings.log_filename);
        let next = if rotate {
            Some(open_log(&settings)?)
        } else {
            None
        };
        if !settings.logging {
            self.file = None;
        } else if let Some((file, path)) = next {
            self.file = Some(file);
            self.path = Some(path);
            self.logged = LineState::default();
        }
        // 关掉日志或关掉「切换时新建」后，之前排队的翻页就不再执行
        self.rotate_pending =
            self.rotate_pending && settings.logging && settings.new_log_on_toggle;
        self.settings = settings;
        Ok(())
    }

    /// 暂停/继续（串口是断开/连接）时调用：按设置排一次翻页。
    /// 真正的新文件等到下一条记录再创建——暂停期间通常没有输出，立刻建文件只会留下空文件。
    pub fn mark_new_file(&mut self) {
        if self.settings.logging && self.settings.new_log_on_toggle {
            self.rotate_pending = true;
        }
    }

    fn rotate_if_pending(&mut self) {
        if !self.rotate_pending {
            return;
        }
        self.rotate_pending = false;
        match open_log(&self.settings) {
            Ok((file, path)) => {
                self.file = Some(file);
                self.path = Some(path);
                self.logged = LineState::default();
            }
            Err(err) => eprintln!("[log] 新建日志文件失败：{err}"),
        }
    }

    /// 文件始终记录接收原文；串口换行转换只影响返回的显示文本。
    /// 日志写入失败时关闭日志文件，仍返回显示内容；调用方无法从此接口获知该写入错误。
    pub fn receive(&mut self, text: &str, is_serial: bool) -> Result<String, String> {
        let display_text = if is_serial && self.settings.cr_as_newline {
            let mut out = String::with_capacity(text.len());
            for c in text.chars() {
                let in_escape = advance_escape(&mut self.serial_escape, c);
                if self.serial_after_cr {
                    self.serial_after_cr = false;
                    if !in_escape && c == '\n' {
                        continue;
                    }
                }
                if !in_escape && c == '\r' {
                    out.push_str("\r\n");
                    self.serial_after_cr = true;
                } else {
                    out.push(c);
                }
            }
            out
        } else {
            self.serial_after_cr = false;
            // 跟踪控制序列，即使此时未开启转换，后续设置变化也不会破坏它。
            for c in text.chars() {
                advance_escape(&mut self.serial_escape, c);
            }
            text.to_owned()
        };
        self.rotate_if_pending();
        let fmt = timestamp_format(&self.settings.timestamp_format);
        let display = self
            .display
            .render(&display_text, self.settings.console_timestamps, fmt.as_ref());
        let write_failed = if let Some(file) = &mut self.file {
            let content = self
                .logged
                .render(text, self.settings.file_timestamps, fmt.as_ref());
            file.write_all(content.as_bytes()).is_err() || file.flush().is_err()
        } else {
            false
        };
        if write_failed {
            // 文件日志失败不能让接收线程丢掉已经准备好的回显内容。
            self.file = None;
        }
        Ok(display)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 每次发送作为单独的 TX 记录；不改变接收方向的行状态。
    pub fn transmit(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        self.rotate_if_pending();
        if let Some(file) = &mut self.file {
            let mut entry = String::new();
            if !self.logged.start {
                entry.push('\n');
            }
            if self.settings.file_timestamps {
                entry.push('[');
                let fmt = timestamp_format(&self.settings.timestamp_format);
                entry.push_str(&Local::now().format(fmt.as_ref()).to_string());
                entry.push_str("] ");
            }
            entry.push_str("[TX] ");
            // 转义换行和控制字符，保证一条发送记录只占一行。
            for c in text.chars() {
                match c {
                    '\r' => entry.push_str("\\r"),
                    '\n' => entry.push_str("\\n"),
                    '\\' => entry.push_str("\\\\"),
                    c if c.is_control() => entry.push_str(&format!("\\u{{{:x}}}", c as u32)),
                    c => entry.push(c),
                }
            }
            entry.push('\n');
            file.write_all(entry.as_bytes())
                .and_then(|_| file.flush())
                .map_err(|e| format!("写入会话日志失败：{e}"))?;
            self.logged = LineState::default();
        }
        Ok(())
    }
}

/// 把界面里的时间格式翻成 chrono 能用的 strftime。
///
/// - 含 `%` 的整串按 strftime 原样使用（兼容手写 `%H:%M:%S` 的老设置）；
/// - 否则按 Java 风格模式翻译：`yyyy` 年、`MM` 月、`dd` 日、`HH` 时、`mm` 分、
///   `ss` 秒、`SSS` 毫秒；其余字符原样保留。
///
/// 之前只特判了默认值，用户把 `yyyy-MM-dd HH:mm:ss.SSS` 改成
/// `yyyy-MM-dd HH:mm:ss` 后剩余部分被当成字面量，屏幕上就直接打印出
/// `[yyyy-MM-dd HH:mm:ss]` 了。
fn timestamp_format(format: &str) -> Cow<'_, str> {
    if format.contains('%') {
        Cow::Borrowed(format)
    } else {
        Cow::Owned(java_pattern_to_strftime(format))
    }
}

fn java_pattern_to_strftime(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Java 的引号：'...' 内原样输出，'' 是字面量单引号
        if c == '\'' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\'' {
                    if chars.get(i + 1) == Some(&'\'') {
                        out.push('\'');
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    out.push(chars[i]);
                    i += 1;
                }
            }
            continue;
        }
        let run = chars[i..].iter().take_while(|&&x| x == c).count();
        let token = match c {
            'y' if run >= 4 => "%Y",
            'y' if run == 2 => "%y",
            'y' => "%Y",
            'M' if run >= 4 => "%B",
            'M' if run == 3 => "%b",
            'M' => "%m",
            'd' => "%d",
            'H' => "%H",
            'm' => "%M",
            's' => "%S",
            // Java 用 S 表示毫秒；strftime 的 %3f 正好是三位小数
            'S' => "%3f",
            'E' if run >= 4 => "%A",
            'E' => "%a",
            'a' => "%p",
            _ => {
                for _ in 0..run {
                    out.push(c);
                }
                i += run;
                continue;
            }
        };
        out.push_str(token);
        i += run;
    }
    out
}

fn validate(settings: &SessionSettings) -> Result<(), String> {
    let fmt = timestamp_format(&settings.timestamp_format);
    if fmt.is_empty() || StrftimeItems::new(fmt.as_ref()).any(|item| matches!(item, Item::Error)) {
        return Err("时间戳格式无效，请使用 yyyy-MM-dd HH:mm:ss 或 strftime 格式".into());
    }
    filename(&settings.log_filename)?;
    if settings.logging
        && settings
            .log_directory
            .as_deref()
            .map_or(true, |s| s.trim().is_empty())
    {
        return Err("启用日志时必须选择日志目录".into());
    }
    Ok(())
}

fn filename(template: &str) -> Result<String, String> {
    let now = Local::now();
    let mut out = String::new();
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let spec = chars.next().ok_or("日志文件名的 % 缺少占位符")?;
        let fmt = match spec {
            'Y' => "%Y",
            'M' => "%m",
            'D' => "%d",
            'h' => "%H",
            'm' => "%M",
            's' => "%S",
            'S' => "%3f",
            '%' => {
                out.push('%');
                continue;
            }
            _ => return Err(format!("未知日志文件名占位符：%{spec}")),
        };
        out.push_str(&now.format(fmt).to_string());
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if out.is_empty()
        || out == "."
        || out == ".."
        || out.ends_with(' ')
        || out.ends_with('.')
        || reserved
        || out
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("日志文件名无效或包含 Windows 禁用字符".into());
    }
    Ok(out)
}

fn open_log(settings: &SessionSettings) -> Result<(File, PathBuf), String> {
    let dir = Path::new(settings.log_directory.as_deref().ok_or("缺少日志目录")?);
    fs::create_dir_all(dir).map_err(|e| format!("创建日志目录失败：{e}"))?;
    let name = filename(&settings.log_filename)?;
    let path = Path::new(&name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(&name);
    let extension = path.extension().and_then(|s| s.to_str());
    for n in 0..100_000u32 {
        let candidate: PathBuf = if n == 0 {
            dir.join(&name)
        } else {
            let suffix = extension.map(|e| format!(".{e}")).unwrap_or_default();
            dir.join(format!("{stem}-{n}{suffix}"))
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建日志文件失败：{e}")),
        }
    }
    Err("日志文件重名次数过多".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    fn dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "pinshell-runtime-log-{}-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn settings(dir: &Path) -> SessionSettings {
        SessionSettings {
            logging: true,
            log_directory: Some(dir.to_string_lossy().into_owned()),
            log_filename: "test.log".into(),
            ..Default::default()
        }
    }
    #[test]
    fn serial_cr_crosses_chunks_without_delaying_display_or_changing_file() {
        let d = dir();
        let mut s = settings(&d);
        s.cr_as_newline = true;
        let mut log = RuntimeLog::new(s).unwrap();
        assert_eq!(log.receive("a\r", true).unwrap(), "a\r\n");
        assert_eq!(log.receive("\nb\rc", true).unwrap(), "b\r\nc");
        assert_eq!(fs::read_to_string(d.join("test.log")).unwrap(), "a\r\nb\rc");
        drop(log);
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn timestamp_does_not_split_ansi_and_is_incremental() {
        let mut s = SessionSettings::default();
        s.console_timestamps = true;
        s.timestamp_format = "T".into();
        let mut log = RuntimeLog::new(s).unwrap();
        assert_eq!(log.receive("\x1b[", false).unwrap(), "\x1b[");
        assert_eq!(log.receive("31mred", false).unwrap(), "31m[T] red");
        assert_eq!(
            log.receive(" more\nnext", false).unwrap(),
            " more\n[T] next"
        );
    }
    #[test]
    fn collision_rotation_and_failed_update_preserve_existing_log() {
        let d = dir();
        let d2 = dir();
        let s = settings(&d);
        let mut first = RuntimeLog::new(s.clone()).unwrap();
        let _second = RuntimeLog::new(s.clone()).unwrap();
        assert!(d.join("test-1.log").exists());
        let mut bad = s.clone();
        bad.log_filename = "../bad".into();
        assert!(first.update(bad).is_err());
        first.receive("old", false).unwrap();
        let mut new = s;
        new.log_directory = Some(d2.to_string_lossy().into_owned());
        first.update(new).unwrap();
        first.receive("new", false).unwrap();
        assert_eq!(fs::read_to_string(d.join("test.log")).unwrap(), "old");
        assert_eq!(fs::read_to_string(d2.join("test.log")).unwrap(), "new");
        drop(first);
        drop(_second);
        fs::remove_dir_all(d).unwrap();
        fs::remove_dir_all(d2).unwrap();
    }
    #[test]
    fn file_timestamps_tx_and_toggle() {
        let d = dir();
        let mut s = settings(&d);
        s.file_timestamps = true;
        s.timestamp_format = "T".into();
        let mut log = RuntimeLog::new(s.clone()).unwrap();
        assert_eq!(log.receive("one", false).unwrap(), "one");
        log.transmit("hi\r\n").unwrap();
        log.receive("two\n", false).unwrap();
        s.logging = false;
        log.update(s.clone()).unwrap();
        log.receive("ignored", false).unwrap();
        s.logging = true;
        log.update(s).unwrap();
        log.receive("new", false).unwrap();
        assert_eq!(
            fs::read_to_string(d.join("test.log")).unwrap(),
            "[T] one\n[T] [TX] hi\\r\\n\n[T] two\n"
        );
        assert_eq!(fs::read_to_string(d.join("test-1.log")).unwrap(), "[T] new");
        drop(log);
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn toggle_rotation_waits_for_the_next_record() {
        let d = dir();
        let mut s = settings(&d);
        s.new_log_on_toggle = true;
        let mut log = RuntimeLog::new(s.clone()).unwrap();
        log.receive("before", false).unwrap();
        log.mark_new_file();
        // 暂停那一刻不建文件：下一次真正有内容时再开新文件，不留下空日志
        assert!(!d.join("test-1.log").exists());
        log.receive("after", false).unwrap();
        assert_eq!(fs::read_to_string(d.join("test.log")).unwrap(), "before");
        assert_eq!(fs::read_to_string(d.join("test-1.log")).unwrap(), "after");

        // 取消勾选后继续/连接不再翻页：内容接着写当前文件
        s.new_log_on_toggle = false;
        log.update(s).unwrap();
        log.mark_new_file();
        log.receive("third", false).unwrap();
        assert_eq!(
            fs::read_to_string(d.join("test-1.log")).unwrap(),
            "afterthird"
        );
        assert!(!d.join("test-2.log").exists());
        drop(log);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn validate_formats_and_windows_names() {
        assert!(filename("%Y%M%D-%h%m%s-%S-%%.log").is_ok());
        for name in ["%q", "x%", "../x", "CON.txt", "x."] {
            assert!(filename(name).is_err(), "{name}");
        }
        let mut s = SessionSettings::default();
        s.timestamp_format = "%Q".into();
        assert!(RuntimeLog::new(s).is_err());
        assert!(RuntimeLog::new(SessionSettings::default()).is_ok());
    }

    #[test]
    fn java_style_timestamp_patterns_are_translated() {
        assert_eq!(timestamp_format("yyyy-MM-dd HH:mm:ss.SSS"), "%Y-%m-%d %H:%M:%S.%3f");
        assert_eq!(timestamp_format("yyyy-MM-dd HH:mm:ss"), "%Y-%m-%d %H:%M:%S");
        assert_eq!(timestamp_format("HH:mm:ss"), "%H:%M:%S");
        // 含百分号的整串按 chrono strftime 原样使用
        assert_eq!(timestamp_format("%H:%M:%S"), "%H:%M:%S");
        // Java 的引号内按字面量输出
        assert_eq!(timestamp_format("yyyy'T'HH"), "%YT%H");
    }

    /// 用户把默认格式改成不带毫秒的写法后，打印的必须是真实时间而不是模式本身。
    #[test]
    fn custom_java_timestamp_renders_real_time() {
        let mut s = SessionSettings::default();
        s.console_timestamps = true;
        s.timestamp_format = "yyyy-MM-dd HH:mm:ss".into();
        let mut log = RuntimeLog::new(s).unwrap();
        let out = log.receive("x", false).unwrap();
        assert!(out.starts_with('['), "{out}");
        assert!(out.ends_with("] x"), "{out}");
        assert!(!out.contains("yyyy"), "{out}");
        assert!(!out.contains("HH"), "{out}");
    }
}
