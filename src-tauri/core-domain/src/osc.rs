//! 从会话输出流里识别标记：OSC 133（提示符/命令边界）、OSC 7（CWD）、备用屏切换。
//!
//! 只读不裁剪：下游拿到的字节流保持不变，由前端自己忽略这些序列。
//! 解析器必须能接住任意切分的块——标记被拆在两个 read() 之间是常态。

/// 从输出流里识别出的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    /// `133;A` 提示符开始
    PromptStart,
    /// `133;B` 提示符结束（用户可输入的位置）
    PromptEnd,
    /// `133;C` 命令开始执行
    CommandStart,
    /// `133;D[;code]` 命令结束；code 为 None 表示 Shell 没给退出码
    CommandEnd { code: Option<i32> },
    /// `7;file://host/C:/path` 工作目录（已解码、已去掉主机与盘符前导斜杠）
    Cwd(String),
    /// `0;title` / `2;title` 窗口标题
    Title(String),
    /// `?1049h` / `?1049l` 等备用屏进出
    AltScreen { entered: bool },
    /// 其它 OSC，仅用于日志，不参与判定
    Other(String),
}

/// 增量解析器：可以喂任意大小的块，事件按到达顺序吐出。
#[derive(Debug, Default)]
pub struct OscParser {
    pending: Vec<u8>,
}

/// `pending` 的上限。永不终止的 `ESC]...`（或 `ESC[` + 无限参数字节）会让尾巴
/// 无界增长：内存被吃光，且提示符判定从此失效。超过上限就整个放弃，从头再来。
/// 64KB 远大于任何合法的 OSC 标记或 CSI 序列。
const MAX_PENDING: usize = 64 * 1024;

impl OscParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一块字节，返回本块能确定的所有事件。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<OscEvent> {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);

        let mut out = Vec::new();
        let mut i = 0;
        let mut keep_from: Option<usize> = None;

        while i < buf.len() {
            if buf[i] != 0x1b {
                i += 1;
                continue;
            }
            // ESC 后面还没有字节，等下一块
            if i + 1 >= buf.len() {
                keep_from = Some(i);
                break;
            }
            match buf[i + 1] {
                b']' => match find_osc_end(&buf, i + 2) {
                    Some((body_end, next)) => {
                        let body = String::from_utf8_lossy(&buf[i + 2..body_end]).into_owned();
                        dispatch_osc(&body, &mut out);
                        i = next;
                    }
                    None => {
                        keep_from = Some(i);
                        break;
                    }
                },
                b'[' => match find_csi_end(&buf, i + 2) {
                    Some((final_idx, next)) => {
                        if matches!(buf[final_idx], b'h' | b'l') {
                            let params =
                                String::from_utf8_lossy(&buf[i + 2..final_idx]).into_owned();
                            if is_alt_screen_param(&params) {
                                out.push(OscEvent::AltScreen {
                                    entered: buf[final_idx] == b'h',
                                });
                            }
                        }
                        i = next;
                    }
                    None => {
                        keep_from = Some(i);
                        break;
                    }
                },
                // 其它两字节转义（ESC M 之类）没有我们要的信息
                _ => i += 2,
            }
        }

        if let Some(k) = keep_from {
            // keep_from 永远指向 buf 的末尾（设置后立即 break），所以尾巴里只有
            // 没拼完的那条序列；丢弃它不会漏掉任何已完整解析的事件。
            let tail = buf.len() - k;
            if tail > MAX_PENDING {
                // 永不终止的序列：整体放弃，等下一块从头开始。
                // 用全新的 Vec 换掉，别让 pending 永久占着 64KB 的堆容量。
                self.pending = Vec::new();
            } else {
                self.pending.extend_from_slice(&buf[k..]);
            }
        }
        out
    }

    /// 还没拼完的尾巴（调试用）。
    pub fn pending(&self) -> &[u8] {
        &self.pending
    }
}

/// 找 OSC 的结束位置：BEL(0x07) 或 ST(ESC)。
/// 返回 (body 结束位置, 下一个字节位置)。
fn find_osc_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j < buf.len() {
        if buf[j] == 0x07 {
            return Some((j, j + 1));
        }
        if buf[j] == 0x1b {
            // ESC 后面没字节：可能是 ST 的前半截，等下一块
            if j + 1 >= buf.len() {
                return None;
            }
            if buf[j + 1] == b'\\' {
                return Some((j, j + 2));
            }
        }
        j += 1;
    }
    None
}

/// 找 CSI 的终止字节（0x40..=0x7e）。返回 (终止字节位置, 下一个字节位置)。
fn find_csi_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j < buf.len() {
        let b = buf[j];
        if (0x40..=0x7e).contains(&b) {
            return Some((j, j + 1));
        }
        // 参数与中间字节之外的东西说明这不是合法 CSI，直接放过
        if !(0x20..=0x3f).contains(&b) {
            return Some((j, j));
        }
        j += 1;
    }
    None
}

/// `?1049` / `?1047` / `?47`，允许带其它参数（`?1049;1004`）。
fn is_alt_screen_param(params: &str) -> bool {
    params
        .trim_start_matches('?')
        .split(';')
        .any(|p| matches!(p.trim(), "1049" | "1047" | "47"))
}

fn dispatch_osc(body: &str, out: &mut Vec<OscEvent>) {
    let (code, rest) = match body.split_once(';') {
        Some((c, r)) => (c, r),
        None => (body, ""),
    };
    match code {
        "133" => {
            let (kind, arg) = match rest.split_once(';') {
                Some((k, a)) => (k, Some(a)),
                None => (rest, None),
            };
            match kind {
                "A" => out.push(OscEvent::PromptStart),
                "B" => out.push(OscEvent::PromptEnd),
                "C" => out.push(OscEvent::CommandStart),
                "D" => out.push(OscEvent::CommandEnd {
                    code: arg.and_then(|a| a.trim().parse::<i32>().ok()),
                }),
                _ => out.push(OscEvent::Other(body.to_string())),
            }
        }
        "7" => out.push(OscEvent::Cwd(normalize_cwd(rest))),
        "0" | "2" => out.push(OscEvent::Title(rest.to_string())),
        _ => out.push(OscEvent::Other(body.to_string())),
    }
}

/// `file://HANK/C:/Program%20Files` → `C:/Program Files`
/// Unix 风格（`/home/x`）原样保留。
fn normalize_cwd(raw: &str) -> String {
    let rest = raw.strip_prefix("file://").unwrap_or(raw);
    // 去掉主机段：第一个 '/' 之后才是路径
    let path = match rest.find('/') {
        Some(idx) => &rest[idx..],
        None => rest,
    };
    let decoded = percent_decode(path);
    // Windows：/C:/x → C:/x
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        decoded[1..].to_string()
    } else {
        decoded
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{OscEvent, OscParser};

    fn parse_all(bytes: &[u8]) -> Vec<OscEvent> {
        let mut p = OscParser::new();
        let mut ev = p.feed(bytes);
        assert!(p.pending().is_empty(), "leftover pending");
        ev.append(&mut p.feed(b""));
        ev
    }

    #[test]
    fn parses_full_prompt_cycle() {
        let stream = b"\x1b]133;A\x07\x1b]7;file://HANK/C:/Users/me\x07PS C:\\Users\\me> \x1b]133;B\x07\
                       \x1b]133;C\x07hi\r\n\x1b]133;D;0\x07";
        assert_eq!(
            parse_all(stream),
            vec![
                OscEvent::PromptStart,
                OscEvent::Cwd("C:/Users/me".into()),
                OscEvent::PromptEnd,
                OscEvent::CommandStart,
                OscEvent::CommandEnd { code: Some(0) },
            ]
        );
    }

    #[test]
    fn command_end_without_code() {
        assert_eq!(
            parse_all(b"\x1b]133;D\x07"),
            vec![OscEvent::CommandEnd { code: None }]
        );
    }

    #[test]
    fn non_zero_exit_code() {
        assert_eq!(
            parse_all(b"\x1b]133;D;7\x07"),
            vec![OscEvent::CommandEnd { code: Some(7) }]
        );
    }

    #[test]
    fn decodes_percent_encoded_cwd() {
        assert_eq!(
            parse_all(b"\x1b]7;file://HANK/C:/Program%20Files\x07"),
            vec![OscEvent::Cwd("C:/Program Files".into())]
        );
    }

    #[test]
    fn unix_style_cwd_kept() {
        assert_eq!(
            parse_all(b"\x1b]7;file://host/home/me\x07"),
            vec![OscEvent::Cwd("/home/me".into())]
        );
    }

    #[test]
    fn alt_screen_enter_and_exit() {
        assert_eq!(
            parse_all(b"\x1b[?1049h\x1b[?1049l"),
            vec![
                OscEvent::AltScreen { entered: true },
                OscEvent::AltScreen { entered: false },
            ]
        );
    }

    #[test]
    fn alt_screen_with_extra_params() {
        assert_eq!(
            parse_all(b"\x1b[?1049;1004h"),
            vec![OscEvent::AltScreen { entered: true }]
        );
    }

    #[test]
    fn ordinary_csi_ignored() {
        // 光标查询、隐藏光标、清屏都不应该产生事件
        assert_eq!(parse_all(b"\x1b[6n\x1b[?25l\x1b[2J\x1b[H"), vec![]);
    }

    #[test]
    fn title_and_unknown_osc() {
        assert_eq!(
            parse_all(b"\x1b]0;my title\x07\x1b]9;9;C:\\x\x07"),
            vec![
                OscEvent::Title("my title".into()),
                OscEvent::Other("9;9;C:\\x".into()),
            ]
        );
    }

    /// 关键回归：标记被任意切成两块都必须得到同一串事件。
    #[test]
    fn same_events_for_every_split_point() {
        let stream = b"pre\x1b]133;A\x07\x1b]7;file://HANK/C:/a%20b\x07$ \x1b]133;B\x07\
                       \x1b]133;C\x07out\x1b]133;D;3\x07\x1b[?1049hpost";
        let expected = parse_all(stream);
        assert!(expected.len() >= 6, "expected events: {expected:?}");

        for cut in 0..=stream.len() {
            let mut p = OscParser::new();
            let mut got = p.feed(&stream[..cut]);
            got.extend(p.feed(&stream[cut..]));
            assert!(p.pending().is_empty(), "pending left at cut {cut}");
            assert_eq!(got, expected, "mismatch when split at {cut}");
        }
    }

    #[test]
    fn byte_at_a_time() {
        let stream = b"\x1b]133;A\x07\x1b]133;D;1\x07";
        let mut p = OscParser::new();
        let mut got = Vec::new();
        for b in stream {
            got.extend(p.feed(std::slice::from_ref(b)));
        }
        assert_eq!(
            got,
            vec![
                OscEvent::PromptStart,
                OscEvent::CommandEnd { code: Some(1) },
            ]
        );
    }

    #[test]
    fn incomplete_escape_is_held_not_dropped() {
        let mut p = OscParser::new();
        assert!(p.feed(b"\x1b").is_empty());
        assert!(!p.pending().is_empty());
        assert!(p.feed(b"]133;").is_empty());
        assert_eq!(p.feed(b"A\x07"), vec![OscEvent::PromptStart]);
        assert!(p.pending().is_empty());
    }

    /// 永不终止的 OSC + 后续大量正常输出：pending 必须有界，且之后能恢复正常判定。
    #[test]
    fn unterminated_osc_is_capped_and_parser_recovers() {
        let mut p = OscParser::new();
        // 一条没有终止符的 OSC，先被留住
        assert!(p.feed(b"\x1b]133;A").is_empty());
        // 之后灌大量普通文本（每块 8KB，共 72KB > 上限）：尾巴超限整体放弃
        let chunk = [b'x'; 8192];
        for _ in 0..9 {
            assert!(p.feed(&chunk).is_empty(), "超限前不应误发任何事件");
        }
        assert!(p.pending().is_empty(), "超限后 pending 必须清空");
        // 恢复正常 OSC 判定：下一条合法标记照常吐事件
        assert_eq!(p.feed(b"\x1b]133;B\x07"), vec![OscEvent::PromptEnd]);
        assert!(p.pending().is_empty());
    }

    /// 永不终止的 CSI（无限参数字节）同样受上限约束。
    #[test]
    fn unterminated_csi_is_capped_too() {
        let mut p = OscParser::new();
        assert!(p.feed(b"\x1b[").is_empty());
        let chunk = [b'0'; 8192];
        for _ in 0..9 {
            assert!(p.feed(&chunk).is_empty(), "超限前不应误发任何事件");
        }
        assert!(p.pending().is_empty(), "超限后 pending 必须清空");
        assert_eq!(
            p.feed(b"\x1b[?1049h"),
            vec![OscEvent::AltScreen { entered: true }]
        );
    }

    /// 上限恰好切在 ESC 序列中间：放弃尾巴后不留半个序列，下一条标记照常判定。
    #[test]
    fn cap_reset_in_the_middle_of_an_escape_is_clean() {
        let mut p = OscParser::new();
        // 完整标记正常吐出，之后跟一条永不终止的 OSC 开头（4 字节留在 pending）
        assert_eq!(
            p.feed(b"\x1b]133;A\x07\x1b]2;"),
            vec![OscEvent::PromptStart]
        );
        // 每块都以半个 ESC 序列（ESC ] ）收尾，保证超限瞬间尾巴停在转义序列中间
        let mut fed = 4usize; // pending 里已有的尾巴
        while fed <= super::MAX_PENDING {
            let mut chunk = vec![b'y'; 8192 - 2];
            chunk.extend_from_slice(b"\x1b]");
            assert!(p.feed(&chunk).is_empty(), "超限前不应误发任何事件");
            fed += chunk.len();
        }
        assert!(p.pending().is_empty(), "超限后半个序列必须整体放弃");
        // 抛掉半个序列之后，下一条正常 OSC 照常判定，不受残留影响
        assert_eq!(
            p.feed(b"\x1b]2;hi\x07"),
            vec![OscEvent::Title("hi".into())]
        );
        assert!(p.pending().is_empty());
    }
}
