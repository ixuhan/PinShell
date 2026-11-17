//! 输出合流：把短时间内读到的多块输出拼成一块再交给前端。
//!
//! 为什么需要：刷屏时（`adb logcat`、`yes`、`Get-Content` 大文件）ConPTY 一次只返回
//! 几 KB，读线程一秒能读到上千块。逐块发一次 `pty:out`，事件数就跟读次数同量级，
//! 主线程和前端要为每块各付一次序列化、调度与队列开销；攒到一帧再发，事件数降到
//! 帧率量级，屏幕内容一个字节都不少。
//!
//! 约定：
//! - 只拼接、不丢字节；空串不入队。
//! - `seq` 取**最后一块**的序号。前端只要求单调递增（`seq` 更大才画），
//!   合流后仍然满足「画过的都答过了」。
//! - 丢弃由调用方决定（暂停时不需要把攒着的块发出去），这里只提供 `clear`。

#[derive(Debug, Default)]
pub struct Coalescer {
    text: String,
    seq: u64,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加一块输出。返回是否真的收了（空块不算，也不影响序号）。
    pub fn push(&mut self, text: &str, seq: u64) -> bool {
        if text.is_empty() {
            return false;
        }
        self.text.push_str(text);
        self.seq = seq;
        true
    }

    /// 取走攒下的全部内容。空缓冲返回 `None`。
    pub fn take(&mut self) -> Option<(String, u64)> {
        if self.text.is_empty() {
            return None;
        }
        let seq = self.seq;
        self.seq = 0;
        Some((std::mem::take(&mut self.text), seq))
    }

    /// 丢掉攒下的内容（暂停时用：内容已经在回放缓冲里，继续时整屏重画）。
    pub fn clear(&mut self) {
        self.text.clear();
        self.seq = 0;
    }

    pub fn len_bytes(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::Coalescer;

    #[test]
    fn joins_chunks_in_order_and_reports_the_last_sequence() {
        let mut c = Coalescer::new();
        assert!(c.push("a", 3));
        assert!(c.push("bc", 4));
        assert_eq!(c.len_bytes(), 3);
        assert_eq!(c.take(), Some(("abc".to_string(), 4)));
        assert!(c.is_empty());
    }

    #[test]
    fn empty_chunks_are_ignored_and_do_not_move_the_sequence() {
        let mut c = Coalescer::new();
        assert!(!c.push("", 9));
        assert!(c.push("x", 2));
        assert_eq!(c.take(), Some(("x".to_string(), 2)));
    }

    #[test]
    fn take_on_empty_returns_none() {
        let mut c = Coalescer::new();
        assert_eq!(c.take(), None);
        c.push("y", 1);
        assert_eq!(c.take(), Some(("y".to_string(), 1)));
        assert_eq!(c.take(), None);
    }

    #[test]
    fn clear_drops_pending_text() {
        let mut c = Coalescer::new();
        c.push("dropped", 5);
        c.clear();
        assert!(c.is_empty());
        assert_eq!(c.take(), None);
    }
}
