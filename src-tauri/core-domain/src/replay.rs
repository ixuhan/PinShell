//! 回放缓冲：热会话保留的最近输出副本。
//!
//! 解决两个场景（见 GLOSSARY「回放缓冲」）：
//! 1. 会话先跑起来、前端后附着——附着时先要一份快照；
//! 2. 前端暂时离开（切会话、页面重载）——回来时补上这段时间的输出。
//!
//! 与前端约定用递增的 `seq` 去重：附着时拿 `snapshot()` 的 `seq`，之后收到的实时块
//! 只有 `seq` 更大的才渲染，避免「快照 + 实时」重叠画出两遍。
//!
//! 裁剪按**整块**丢，不切半个转义序列；空块不占序号。
//! 这是纯数据规则，落盘与卷轴快照不在这里（见 M2 / M3）。

use std::collections::VecDeque;

struct Chunk {
    seq: u64,
    text: String,
}

/// 一次附着拿到的快照：`text` 覆盖到 `seq` 为止。
pub struct Snapshot {
    pub seq: u64,
    pub text: String,
    /// 因为超上限被丢掉的字节数，仅用于诊断与「回放不完整」的提示
    pub dropped_bytes: u64,
}

pub struct ReplayBuffer {
    cap_bytes: usize,
    chunks: VecDeque<Chunk>,
    bytes: usize,
    dropped_bytes: u64,
    next_seq: u64,
}

impl ReplayBuffer {
    /// 序号从 1 开始，空缓冲的快照 `seq == 0`，前端因此可以用 0 作为「还没见过任何块」。
    pub fn new(cap_bytes: usize) -> Self {
        Self {
            cap_bytes,
            chunks: VecDeque::new(),
            bytes: 0,
            dropped_bytes: 0,
            next_seq: 1,
        }
    }

    /// 记一块输出并返回它的序号。空串不记录、也不消耗序号。
    pub fn push(&mut self, text: &str) -> Option<u64> {
        if text.is_empty() {
            return None;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.bytes += text.len();
        self.chunks.push_back(Chunk {
            seq,
            text: text.to_string(),
        });
        // 至少留最新一块：单块就超上限时宁可越过上限，也不要给出空回放
        while self.bytes > self.cap_bytes && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.bytes -= old.text.len();
                self.dropped_bytes += old.text.len() as u64;
            }
        }
        Some(seq)
    }

    pub fn snapshot(&self) -> Snapshot {
        let seq = self.chunks.back().map(|c| c.seq).unwrap_or(0);
        let mut text = String::with_capacity(self.bytes);
        for chunk in &self.chunks {
            text.push_str(&chunk.text);
        }
        Snapshot {
            seq,
            text,
            dropped_bytes: self.dropped_bytes,
        }
    }

    /// 一键清窗口用：丢掉回放内容，但序号继续往前走，
    /// 免得前端把「清空前的实时块」当成新内容补画回来。
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }

    pub fn len_bytes(&self) -> usize {
        self.bytes
    }

    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::ReplayBuffer;

    #[test]
    fn sequences_start_at_one_and_snapshot_covers_last_chunk() {
        let mut buf = ReplayBuffer::new(1024);
        assert_eq!(buf.push("a"), Some(1));
        assert_eq!(buf.push("bc"), Some(2));
        let snap = buf.snapshot();
        assert_eq!(snap.seq, 2);
        assert_eq!(snap.text, "abc");
    }

    #[test]
    fn empty_chunk_does_not_consume_a_sequence() {
        let mut buf = ReplayBuffer::new(1024);
        assert_eq!(buf.push(""), None);
        assert_eq!(buf.push("x"), Some(1));
        assert!(!buf.is_empty());
        assert_eq!(buf.snapshot().text, "x");
    }

    #[test]
    fn empty_buffer_snapshots_at_seq_zero() {
        let buf = ReplayBuffer::new(1024);
        let snap = buf.snapshot();
        assert_eq!(snap.seq, 0);
        assert_eq!(snap.text, "");
        assert_eq!(snap.dropped_bytes, 0);
    }

    #[test]
    fn trims_whole_oldest_chunks_and_reports_dropped_bytes() {
        let mut buf = ReplayBuffer::new(6);
        buf.push("aaa"); // 3
        buf.push("bbb"); // 6
        buf.push("cc"); // 8 -> 丢 aaa
        let snap = buf.snapshot();
        assert_eq!(snap.text, "bbbcc");
        assert_eq!(snap.seq, 3);
        assert_eq!(buf.dropped_bytes(), 3);
        assert_eq!(buf.len_bytes(), 5);
    }

    #[test]
    fn a_single_oversized_chunk_is_kept() {
        let mut buf = ReplayBuffer::new(4);
        buf.push("0123456789");
        assert_eq!(buf.snapshot().text, "0123456789");
        assert_eq!(buf.dropped_bytes(), 0);
    }

    #[test]
    fn clear_drops_text_but_sequences_keep_moving() {
        let mut buf = ReplayBuffer::new(1024);
        buf.push("old");
        buf.clear();
        assert!(buf.is_empty());
        assert_eq!(buf.snapshot().seq, 0);
        assert_eq!(buf.push("new"), Some(2));
        assert_eq!(buf.snapshot().seq, 2);
        assert_eq!(buf.snapshot().text, "new");
    }
}
