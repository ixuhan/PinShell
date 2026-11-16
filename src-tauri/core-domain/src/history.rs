//! 命令历史的纯规则：什么算一行、连续重复怎么处理、上限怎么裁剪。
//!
//! 落盘、掩码、去重窗口与模糊检索不在这个模块（见 M3）。

use std::collections::VecDeque;

/// 记一行。返回是否真的记下了。
///
/// - 去掉结尾的回车/换行（提交时写入的是 `line + "\r"`）；
/// - 空白行不记；
/// - 与上一条完全相同不记（连续重复按 ↑ 只会看到同一条）；
/// - 超过 `cap` 从最旧的开始丢。
pub fn remember(history: &mut VecDeque<String>, data: &str, cap: usize) -> bool {
    let line = data.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return false;
    }
    if history.back().map(|last| last == line).unwrap_or(false) {
        return false;
    }
    if history.len() >= cap {
        history.pop_front();
    }
    history.push_back(line.to_string());
    true
}

#[cfg(test)]
mod tests {
    use super::remember;
    use std::collections::VecDeque;

    fn lines(history: &VecDeque<String>) -> Vec<&str> {
        history.iter().map(String::as_str).collect()
    }

    #[test]
    fn strips_trailing_line_endings() {
        let mut h = VecDeque::new();
        assert!(remember(&mut h, "echo hi\r", 10));
        assert_eq!(lines(&h), vec!["echo hi"]);
    }

    #[test]
    fn ignores_blank_lines() {
        let mut h = VecDeque::new();
        assert!(!remember(&mut h, "\r", 10));
        assert!(!remember(&mut h, "   \r", 10));
        assert!(h.is_empty());
    }

    #[test]
    fn consecutive_duplicates_collapse_but_not_later_ones() {
        let mut h = VecDeque::new();
        assert!(remember(&mut h, "git status\r", 10));
        assert!(!remember(&mut h, "git status\r", 10));
        assert!(remember(&mut h, "ls\r", 10));
        assert!(remember(&mut h, "git status\r", 10));
        assert_eq!(lines(&h), vec!["git status", "ls", "git status"]);
    }

    #[test]
    fn drops_oldest_at_capacity() {
        let mut h = VecDeque::new();
        for i in 0..3 {
            remember(&mut h, &format!("cmd {i}\r"), 2);
        }
        assert_eq!(lines(&h), vec!["cmd 1", "cmd 2"]);
    }

    #[test]
    fn keeps_inner_newlines_but_trims_only_the_tail() {
        let mut h = VecDeque::new();
        assert!(remember(&mut h, "a\r\nb\r", 10));
        assert_eq!(lines(&h), vec!["a\r\nb"]);
    }
}
