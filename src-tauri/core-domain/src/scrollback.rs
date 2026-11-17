//! 卷轴快照的组装规则：冷会话重新拉起时，把上次的屏幕内容接在前面。
//!
//! 快照**只用于显示**，不进入命令历史，也不参与输入所有权判定（见 GLOSSARY「卷轴快照」）。
//! 这里只有字符串拼装，读写文件在 `src-tauri/src/persistence.rs`。

/// 分隔线：把「上次会话」和「这次会话」的屏幕断开。
/// 前缀换行与 `\r\n` 是为了不粘连上一行的残留格式；颜色用 245 号灰，与普通输出区分。
pub const SEPARATOR: &str = "\r\n\x1b[38;5;245m──────── 上次会话结束于此 ────────\x1b[0m\r\n";

/// 把上次的快照接在新会话前面。没有历史（空快照）时返回空串：
/// 不该凭空画一条没有内容的分隔线。
pub fn compose(previous: &str) -> String {
    if previous.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(previous.len() + SEPARATOR.len() + 2);
    out.push_str(previous);
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
        assert_eq!(out, format!("PS C:\\> \r\n{SEPARATOR}"));
        // 已有换行时不重复补
        let with_break = compose("PS C:\\> \r\n");
        assert_eq!(with_break, format!("PS C:\\> \r\n{SEPARATOR}"));
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
}
