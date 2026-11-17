//! 卷轴快照的组装规则：冷会话重新拉起时，把上次的屏幕内容接在前面。
//!
//! 快照**只用于显示**，不进入命令历史，也不参与输入所有权判定（见 GLOSSARY「卷轴快照」）。
//! 这里只有字符串拼装，读写文件在 `src-tauri/src/persistence.rs`。

use std::borrow::Cow;

/// 分隔线：把「上次会话」和「这次会话」的屏幕断开。
/// 前缀换行与 `\r\n` 是为了不粘连上一行的残留格式；颜色用 245 号灰，与普通输出区分。
pub const SEPARATOR: &str = "\r\n\x1b[38;5;245m──────── 上次会话结束于此 ────────\x1b[0m\r\n";

/// 回放里要丢掉的终端开关：备用屏进出（否则内容画在一块随时会丢弃的缓冲上），
/// 以及隐藏光标（快照常停在 vim 隐藏光标的状态）。
const DROPPED_SWITCHES: [&str; 7] = [
    "\x1b[?1049h",
    "\x1b[?1049l",
    "\x1b[?1047h",
    "\x1b[?1047l",
    "\x1b[?47h",
    "\x1b[?47l",
    "\x1b[?25l",
];

/// 回放末尾的复位：清掉残留的 SGR，并把被隐藏的光标放出来。
const TAIL_RESET: &str = "\x1b[0m\x1b[?25h";

/// 删掉回放内容里的**终端查询**，只留能画出来的东西。
///
/// 为什么必须删：查询是问终端的（`CSI 6 n` 光标在哪、`CSI c` 你是谁、OSC 颜色值……），
/// 终端按规矩要回答，而回答会顺着同一个输入通道被当成用户按键送进 Shell。正常运行时这是
/// 对的——Shell 自己问的，自己知道怎么读；可**回放不是一次提问**，Shell 从没问过，
/// 收到只会当成乱码：PSReadLine 会响铃（它的 Audible 铃是自己放音效，终端静音不了），
/// 运气不好还会把字符塞进命令行。于是每次切会话都响一声。
///
/// 认得出的一律删：`CSI ... n` / `CSI ... c`（含 `?`、`>` 前缀）、`CSI > ... q`（版本查询）、
/// 以 `?` 结尾的 OSC（颜色/字体查询）、带 `$q` 的 DCS（DECRQSS）。
/// 序列没写完整（块边界）时原样保留，宁可不删也不吃掉后面的内容。
pub fn without_host_queries(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut i = 0;
    let mut changed = false;

    while i < bytes.len() {
        if bytes[i] != 0x1b {
            i += 1;
            continue;
        }
        let Some(&kind) = bytes.get(i + 1) else { break };
        let (next, drop) = match kind {
            b']' => match osc_end(bytes, i + 2) {
                Some((body_end, next)) => (next, text[i + 2..body_end].trim_end().ends_with('?')),
                None => break,
            },
            b'[' => match csi_end(bytes, i + 2) {
                Some((final_idx, next)) => {
                    let params = &text[i + 2..final_idx];
                    let is_query = matches!(bytes[final_idx], b'n' | b'c')
                        || (bytes[final_idx] == b'q' && params.starts_with('>'));
                    (next, is_query)
                }
                None => break,
            },
            b'P' => match st_end(bytes, i + 2) {
                Some((body_end, next)) => (next, text[i + 2..body_end].contains("$q")),
                None => break,
            },
            _ => (i + 2, false),
        };
        if drop {
            out.push_str(&text[copied..i]);
            copied = next;
            changed = true;
        }
        i = next;
    }

    if !changed {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}

/// OSC 的结束位置：BEL 或 ST（`ESC \`）。返回 (body 结束, 下一个字节)。
pub(crate) fn osc_end(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j < bytes.len() {
        match bytes[j] {
            0x07 => return Some((j, j + 1)),
            0x1b if bytes.get(j + 1) == Some(&b'\\') => return Some((j, j + 2)),
            _ => j += 1,
        }
    }
    None
}

/// CSI 的结束位置（终止字节 0x40..=0x7e）。返回 (终止字节, 下一个字节)。
pub(crate) fn csi_end(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j < bytes.len() {
        let b = bytes[j];
        if (0x40..=0x7e).contains(&b) {
            return Some((j, j + 1));
        }
        if !(0x20..=0x3f).contains(&b) {
            return None;
        }
        j += 1;
    }
    None
}

/// DCS 的结束位置：ST（`ESC \`）。返回 (body 结束, 下一个字节)。
pub(crate) fn st_end(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut j = from;
    while j + 1 < bytes.len() {
        if bytes[j] == 0x1b && bytes[j + 1] == b'\\' {
            return Some((j, j + 2));
        }
        j += 1;
    }
    None
}

/// 把上次的快照接在新会话前面。没有历史（空快照）时返回空串：
/// 不该凭空画一条没有内容的分隔线。
///
/// 快照里的**终端查询**一律删掉：那是上一个进程问的，早就没人等了，
/// 画上去只会让终端再答一次，答案回到新 Shell 里就是乱码。
pub fn compose(previous: &str) -> String {
    if previous.is_empty() {
        return String::new();
    }
    let previous = without_host_queries(previous);
    let mut out = String::with_capacity(previous.len() + SEPARATOR.len() + TAIL_RESET.len() + 2);
    out.push_str(previous.as_ref());
    for switch in DROPPED_SWITCHES {
        if out.contains(switch) {
            out = out.replace(switch, "");
        }
    }
    out.push_str(TAIL_RESET);
    // 进程被强行结束时，快照常停在没有换行的半行上；补一个换行，
    // 否则分隔线会接在那半行的末尾，看起来像同一条输出。
    if !previous.ends_with('\n') {
        out.push_str("\r\n");
    }
    out.push_str(SEPARATOR);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_previous_composes_to_nothing() {
        assert_eq!(compose(""), "");
    }

    #[test]
    fn compose_strips_queries_from_the_old_screen() {
        // 上一个进程问的查询早就没人在等：留在卷轴里会让新终端再答一次
        let out = compose("\x1b[6nold\x1b[?1;2c\r\n");
        assert!(!out.contains("\x1b[6n"));
        assert!(!out.contains("\x1b[?1;2c"));
        assert!(out.contains("old"));
    }

    #[test]
    fn separator_follows_the_previous_screen() {
        let out = compose("hello\r\n");
        assert!(out.starts_with("hello\r\n"));
        assert!(out.ends_with(SEPARATOR));
        // 只有一条分隔线，且不额外插入空行
        assert_eq!(out.matches("上次会话结束于此").count(), 1);
    }

    #[test]
    fn half_line_gets_a_line_break_before_the_separator() {
        // 快照末尾没有换行：补换行再接分隔线，避免粘在提示符后面
        let out = compose("PS C:\\> ");
        assert_eq!(out, format!("PS C:\\> {TAIL_RESET}\r\n{SEPARATOR}"));
        // 已有换行时不重复补
        let with_break = compose("PS C:\\> \r\n");
        assert_eq!(with_break, format!("PS C:\\> \r\n{TAIL_RESET}{SEPARATOR}"));
    }

    #[test]
    fn alt_screen_switches_are_stripped_so_replay_stays_on_the_normal_screen() {
        // vim 里退出：快照带备用屏进出，回放时不能再切一次备用屏
        let out = compose("line one\r\n\x1b[?1049hVIM\x1b[?1049l\r\n");
        assert!(!out.contains("?1049"));
        assert!(out.contains("VIM"));
        assert!(out.ends_with(SEPARATOR));
    }

    #[test]
    fn tail_reset_releases_attributes_and_the_cursor() {
        // 快照可能停在隐藏光标/带颜色的状态，新会话不该继承这些
        let out = compose("\x1b[?25l\x1b[31mred\x1b[0m\r\n");
        assert!(out.contains(TAIL_RESET));
        assert!(!out.contains("?25l"));
    }

    #[test]
    fn compose_is_idempotently_prefixed() {
        // 反复重开：每次都在最前面追加自己的分隔线，历史内容原样保留
        let once = compose("old\r\n");
        let twice = compose(&once);
        assert!(twice.starts_with("old\r\n"));
        assert_eq!(twice.matches("上次会话结束于此").count(), 2);
    }

    #[test]
    fn separator_contains_no_osc_sequences() {
        // 分隔线不许混进 133/7 这类标记：那会被状态机当成真实提示符
        assert!(!SEPARATOR.contains("]133;"));
        assert!(!SEPARATOR.contains("]7;"));
    }

    #[test]
    fn host_queries_are_not_replayed() {
        // 这些序列都要求终端应答。回放时若照原样画上去，应答会顺着输入通道
        // 被当成用户按键送进 Shell，Shell 只能当成乱码并响铃。
        for query in [
            "\x1b[6n",
            "\x1b[5n",
            "\x1b[?6n",
            "\x1b[c",
            "\x1b[>0c",
            "\x1b[>0q",
        ] {
            let text = format!("PS> {query}");
            let out = without_host_queries(&text);
            assert_eq!(out, "PS> ", "still there: {query:?}");
        }
    }

    #[test]
    fn osc_and_dcs_queries_are_dropped() {
        let text = "\x1b]11;?\x07\x1b]4;1;?\x07\x1bP$q\"p\x1b\\ok";
        assert_eq!(without_host_queries(text), "ok");
    }

    #[test]
    fn ordinary_output_is_kept_byte_for_byte() {
        // 颜色、133 标记、CWD、标题都不删，而且没有可删的东西时不复制
        let text = "PS C:\\> \x1b[32mgreen\x1b[0m\r\n\x1b]133;A\x07\x1b]7;file://h/C:/x\x07\x1b]0;t\x07";
        assert!(matches!(without_host_queries(text), Cow::Borrowed(_)));
        assert_eq!(without_host_queries(text), text);
    }

    #[test]
    fn multibyte_text_survives_the_strip() {
        let text = "会话\x1b[6n结束";
        assert_eq!(without_host_queries(text), "会话结束");
    }

    #[test]
    fn incomplete_sequences_are_left_alone() {
        // 回放块可能截断在半条序列上：不能为此吃掉后面的内容
        let text = "abc\x1b[6";
        assert_eq!(without_host_queries(text), text);
    }
}
