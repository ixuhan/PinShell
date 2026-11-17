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

    /// 附着快照：`answered_seq` 是「前端已经画到过的最大序号」。
    ///
    /// 以它为界，回放分两半，规矩不一样：
    /// - **已画过的块**（`seq <= answered_seq`）：终端查询当时已经应答过了。再画一遍会让终端
    ///   再答一次，答案顺着输入通道回到 Shell 就是它没问过的乱码。所以只留能画的东西。
    /// - **没画过的块**（`seq > answered_seq`）：包括「会话已启动、前端还没附着」这段输出。
    ///   没人答过这些查询，而 Shell 很可能正卡在那儿等应答（pwsh 启动第一条就是 `CSI 6 n`）。
    ///   必须原样交给终端——删掉它，Shell 会一直停在「直通模式」不动。
    pub fn snapshot_for_attach(&self, answered_seq: u64) -> Snapshot {
        let mut snapshot = self.snapshot();
        if answered_seq > 0 {
            let mut text = String::with_capacity(snapshot.text.len());
            for chunk in &self.chunks {
                if chunk.seq <= answered_seq {
                    text.push_str(&crate::scrollback::without_host_queries(&chunk.text));
                } else {
                    text.push_str(&chunk.text);
                }
            }
            snapshot.text = text;
        }
        snapshot
    }

    /// 一键清窗口用：丢掉回放内容，但序号继续往前走，
    /// 免得前端把「清空前的实时块」当成新内容补画回来。
    /// 返回清空前的最后序号：前端拿它把还在路上的旧块一起丢掉。
    pub fn clear(&mut self) -> u64 {
        let seq = self.next_seq.saturating_sub(1);
        self.chunks.clear();
        self.bytes = 0;
        seq
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
        // 清空前的最末序号交回给调用方：前端用它丢掉在途的旧块
        assert_eq!(buf.clear(), 1);
        assert!(buf.is_empty());
        assert_eq!(buf.snapshot().seq, 0);
        assert_eq!(buf.push("new"), Some(2));
        assert_eq!(buf.snapshot().seq, 2);
        assert_eq!(buf.snapshot().text, "new");
        assert_eq!(buf.clear(), 2);
    }

    #[test]
    fn first_attach_keeps_queries_the_shell_may_be_waiting_for() {
        // 冷启动：前端还没画过任何东西（answered_seq = 0），pwsh 的第一条 `CSI 6 n`
        // 没人答过，删掉它 Shell 就停在提示符前不动了。
        let mut buf = ReplayBuffer::new(1024);
        buf.push("\x1b[6n");
        assert_eq!(buf.snapshot_for_attach(0).text, "\x1b[6n");
    }

    #[test]
    fn re_attach_strips_queries_that_were_already_answered() {
        let mut buf = ReplayBuffer::new(1024);
        buf.push("\x1b[6nPS> ");
        let snap = buf.snapshot_for_attach(1);
        assert_eq!(snap.text, "PS> ");
        assert_eq!(snap.seq, 1);
    }

    #[test]
    fn chunks_after_the_answered_point_keep_their_queries() {
        // 断线期间 Shell 自己问的：没人答过，重连时必须交给终端
        let mut buf = ReplayBuffer::new(1024);
        buf.push("\x1b[6n"); // seq 1：已经画过
        buf.push("PS> \x1b[5n"); // seq 2：断线期间来的
        let snap = buf.snapshot_for_attach(1);
        assert_eq!(snap.text, "PS> \x1b[5n");
    }
}
