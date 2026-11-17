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

/// 清屏时保留的那一行最多留这么多字节：提示符通常几十字节，
/// 超过就只留尾部——一条没有换行的进度条不该把「清屏」变成搬一兆字节。
const KEEP_LINE_CAP: usize = 4096;

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
    /// 清屏时留在屏幕上的一行（光标所在行，通常就是提示符）。
    ///
    /// 前端的 `term.clear()` 会把当前行提到首行、只清历史，所以清屏之后屏幕不是全黑的；
    /// 回放必须从同一行开始，否则切走再切回来、或者重载页面，那一行提示符就没了。
    /// 它是字节原样（颜色转义都在），接在每份快照的最前面。
    residue: String,
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
            residue: String::new(),
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
        let mut text = String::with_capacity(self.residue.len() + self.bytes);
        text.push_str(&self.residue);
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
        if answered_seq == 0 && self.residue.is_empty() {
            return snapshot;
        }
        let mut text = String::with_capacity(snapshot.text.len());
        // 保留行是清屏前就已经画过的：里面的终端查询早答过了，重画只会让终端再答一遍
        text.push_str(&crate::scrollback::without_host_queries(&self.residue));
        for chunk in &self.chunks {
            if chunk.seq <= answered_seq {
                text.push_str(&crate::scrollback::without_host_queries(&chunk.text));
            } else {
                text.push_str(&chunk.text);
            }
        }
        snapshot.text = text;
        snapshot
    }

    /// 一键清窗口用：丢掉回放内容，但留住光标所在的那一行（通常就是提示符），
    /// 与前端的 `term.clear()` 保持同一语义；序号继续往前走，
    /// 免得前端把「清空前的实时块」当成新内容补画回来。
    /// 返回清空前的最后序号：前端拿它把还在路上的旧块一起丢掉。
    pub fn clear(&mut self) -> u64 {
        let seq = self.next_seq.saturating_sub(1);
        self.residue = self.current_line();
        self.chunks.clear();
        self.bytes = 0;
        seq
    }

    /// 回放文本里光标所在的那一行：最后一个换行之后的部分。
    /// 已经是「只剩一行」的状态时（连续清屏），就从保留行算起。
    fn current_line(&self) -> String {
        let mut line = String::new();
        let mut found_break = false;
        for chunk in self.chunks.iter().rev() {
            if let Some(pos) = chunk.text.rfind('\n') {
                line.insert_str(0, &chunk.text[pos + 1..]);
                found_break = true;
                break;
            }
            line.insert_str(0, &chunk.text);
            // 已经攒够一行了，再往前找也只会被裁掉
            if line.len() >= KEEP_LINE_CAP {
                break;
            }
        }
        if !found_break {
            line.insert_str(0, &self.residue);
        }
        cap_line(line)
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

/// 保留行只留尾部，免得一条没有换行的进度条把「清屏」变成搬几百 KB。
///
/// 切点若落在半条转义序列里，就挪到那条序列之后：回放时半条 `CSI` 会把后面的字
/// 一起吞掉，屏幕上就只剩一个光标了。
fn cap_line(line: String) -> String {
    if line.len() <= KEEP_LINE_CAP {
        return line;
    }
    let bytes = line.as_bytes();
    let mut cut = line.len() - KEEP_LINE_CAP;
    let mut i = 0;
    while i < cut {
        if bytes[i] == 0x1b {
            if let Some(end) = escape_end(bytes, i) {
                if end > cut {
                    cut = end;
                    break;
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    while cut < line.len() && !line.is_char_boundary(cut) {
        cut += 1;
    }
    line[cut..].to_string()
}

/// 转义序列结束后的第一个下标；序列没写完整时返回 `None`。
fn escape_end(bytes: &[u8], at: usize) -> Option<usize> {
    match *bytes.get(at + 1)? {
        b']' => crate::scrollback::osc_end(bytes, at + 2).map(|(_, next)| next),
        b'[' => crate::scrollback::csi_end(bytes, at + 2).map(|(_, next)| next),
        b'P' => crate::scrollback::st_end(bytes, at + 2).map(|(_, next)| next),
        _ => Some(at + 2),
    }
}

#[cfg(test)]
mod tests {
    use super::{ReplayBuffer, KEEP_LINE_CAP};

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
        buf.push("old\r\n");
        // 清空前的最末序号交回给调用方：前端用它丢掉在途的旧块
        assert_eq!(buf.clear(), 1);
        assert!(buf.is_empty());
        assert_eq!(buf.snapshot().seq, 0);
        assert_eq!(buf.snapshot().text, "");
        assert_eq!(buf.push("new"), Some(2));
        assert_eq!(buf.snapshot().seq, 2);
        assert_eq!(buf.snapshot().text, "new");
        assert_eq!(buf.clear(), 2);
    }

    #[test]
    fn clear_keeps_the_current_line_like_the_terminal_does() {
        // 前端 `term.clear()` 会把光标那一行提到首行：回放必须从同一行开始，
        // 否则切走再切回来，那一行提示符就没了（只剩一个光标）。
        let mut buf = ReplayBuffer::new(1024);
        buf.push("history\r\nPS C:\\Users\\me> ");
        assert_eq!(buf.clear(), 1);
        assert_eq!(buf.snapshot().text, "PS C:\\Users\\me> ");
        assert_eq!(buf.push("ls"), Some(2));
        assert_eq!(buf.snapshot().text, "PS C:\\Users\\me> ls");
    }

    #[test]
    fn clear_replays_the_current_line_after_reattach() {
        let mut buf = ReplayBuffer::new(1024);
        buf.push("history\r\nPS> ");
        let cleared = buf.clear();
        // 切走再切回来：前端「答到」清屏前的位置，保留行照样得还给它
        assert_eq!(buf.snapshot_for_attach(cleared).text, "PS> ");
    }

    #[test]
    fn clear_joins_a_line_split_across_chunks() {
        // 提示符常常是分几块吐出来的：保留行不能只认最后一块
        let mut buf = ReplayBuffer::new(1024);
        buf.push("done\r\nPS");
        buf.push(" C:\\> ");
        buf.clear();
        assert_eq!(buf.snapshot().text, "PS C:\\> ");
    }

    #[test]
    fn clearing_twice_keeps_the_same_line() {
        let mut buf = ReplayBuffer::new(1024);
        buf.push("history\r\nPS> ");
        buf.clear();
        buf.clear();
        assert_eq!(buf.snapshot().text, "PS> ");
    }

    #[test]
    fn the_kept_line_never_repeats_a_host_query() {
        // 保留行在清屏前就画过、查询早答过了：重画时再带上它，终端会再答一遍，
        // 答案顺着输入通道回到 Shell 就是乱码
        let mut buf = ReplayBuffer::new(1024);
        buf.push("old\r\nPS> \x1b[6n");
        buf.clear();
        assert_eq!(buf.snapshot_for_attach(0).text, "PS> ");
    }

    #[test]
    fn clear_caps_a_pathological_line_to_its_tail() {
        let mut buf = ReplayBuffer::new(64 * 1024);
        let long = "x".repeat(KEEP_LINE_CAP * 2);
        buf.push(&format!("head\r\n{long}"));
        buf.clear();
        let text = buf.snapshot().text;
        assert!(text.len() <= KEEP_LINE_CAP, "kept {} bytes", text.len());
        assert!(text.ends_with("xxx"));
    }

    #[test]
    fn capped_line_does_not_start_inside_an_escape_sequence() {
        // 切点落在半条序列上时，回放会把后面的字一起吞掉
        let mut buf = ReplayBuffer::new(64 * 1024);
        let line = format!("{}\x1b[38;5;245m{}", "x".repeat(100), "y".repeat(4090));
        buf.push(&line);
        buf.clear();
        let text = buf.snapshot().text;
        assert!(text.starts_with('y'), "kept: {:?}", &text[..8]);
        assert!(text.len() <= KEEP_LINE_CAP);
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
