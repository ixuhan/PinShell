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

    /// 带 1MB 上限的追加：超限时旧缓冲整体让位给新块。
    ///
    /// 与 [`Coalescer::push`] 的差别只在「缓冲即将超上限」这一种情况：
    /// 旧内容整体丢弃、换上本块——被丢的内容早已写进回放缓冲，暂停结束时
    /// 前端按回放整屏重画，不会缺字。空块照旧早退：不写、不清空、不占序号。
    pub fn push_capped(&mut self, text: &str, seq: u64, max_bytes: usize) -> bool {
        if text.is_empty() {
            return false;
        }
        if self.text.len() + text.len() > max_bytes {
            // 全新的 String 换掉旧缓冲：连同峰值堆容量一起释放，别只 clear。
            self.text = String::new();
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

    /// 超限时旧缓冲整体让位：内存有界，seq 仍取最后一块。
    #[test]
    fn push_capped_discards_old_text_when_over_the_limit() {
        let mut c = Coalescer::new();
        assert!(c.push("old-1", 1));
        assert!(c.push("old-2", 2));
        // 7 字节旧内容 + 5 字节新块 = 12 > 10：触发整体让位
        assert!(c.push_capped("new!!", 9, 10));
        assert!(c.len_bytes() <= 10, "超限后必须回到上限以内");
        assert_eq!(c.take(), Some(("new!!".to_string(), 9)), "seq 取最后一块");
    }

    /// 空块在上限判断之前早退：不清空攒着的内容，也不动 seq。
    #[test]
    fn push_capped_ignores_empty_chunks_even_when_over_the_limit() {
        let mut c = Coalescer::new();
        c.push("kept", 3);
        // 缓冲已超「上限」，但空块不该触发清空
        assert!(!c.push_capped("", 7, 2));
        assert_eq!(c.take(), Some(("kept".to_string(), 3)));
    }

    /// 连续超限：每次都回到上限以内，内存不随灌入量增长。
    #[test]
    fn push_capped_stays_bounded_under_sustained_overload() {
        let mut c = Coalescer::new();
        let big = "y".repeat(4096);
        for seq in 0..1000u64 {
            c.push_capped(&big, seq, 8192);
            assert!(c.len_bytes() <= 8192, "seq {seq} 时超限");
        }
        assert_eq!(c.seq, 999, "seq 跟到最后一块");
    }

    /// 未触上限时 push_capped 与 push 完全一致：逐字节完整、seq 为最后一块。
    #[test]
    fn push_capped_matches_push_below_the_limit() {
        let mut capped = Coalescer::new();
        let mut plain = Coalescer::new();
        let chunks = [("a", 1), ("bcd", 2), ("", 3), ("efg", 4)];
        for (text, seq) in chunks {
            capped.push_capped(text, seq, 64);
            plain.push(text, seq);
        }
        assert_eq!(capped.take(), plain.take());
    }

    /// 超限让位后堆容量确实释放：新一轮灌入不会叠加在旧容量之上。
    #[test]
    fn push_capped_releases_peak_capacity_on_reset() {
        let mut c = Coalescer::new();
        c.push_capped(&"x".repeat(8192), 1, 8192);
        assert!(c.len_bytes() <= 8192);
        // 再来一块触发让位：缓冲换新，容量不得残留上一轮的峰值
        c.push_capped(&"z".repeat(16), 2, 8192);
        assert_eq!(c.len_bytes(), 16);
        assert_eq!(c.seq, 2);
    }
}
