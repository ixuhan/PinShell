//! 跨读取块保持 UTF-8 完整：不足一个字符的尾部留到下一次。

/// 把任意切分的字节块重新拼成字符串，保证多字节字符不被切成两个替换符。
#[derive(Debug, Default)]
pub struct Utf8Stream {
    tail: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self { tail: Vec::new() }
    }

    /// 喂一块字节，返回本次能确定的文本（可能为空）。
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.tail.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.tail) {
                Ok(s) => {
                    out.push_str(s);
                    self.tail.clear();
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    if valid > 0 {
                        out.push_str(std::str::from_utf8(&self.tail[..valid]).unwrap_or(""));
                        self.tail.drain(..valid);
                    }
                    match err.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.tail.drain(..len);
                        }
                        // 尾部是不完整的多字节序列，等下一块
                        None => break,
                    }
                }
            }
        }
        out
    }

    /// 流结束时调用：把尾部残缺的字节按一个替换符吐出，不让它悄悄消失。
    pub fn finish(&mut self) -> String {
        if self.tail.is_empty() {
            return String::new();
        }
        self.tail.clear();
        "\u{FFFD}".to_string()
    }

    /// 仍留在缓冲区里的字节（供调试与断言用）。
    pub fn pending(&self) -> &[u8] {
        &self.tail
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    /// 中文 + emoji 在任意位置被切断，重组结果都必须等于整串。
    fn assert_split_invariant(text: &str) {
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut s = Utf8Stream::new();
            let mut got = String::new();
            got.push_str(&s.push(&bytes[..cut]));
            got.push_str(&s.push(&bytes[cut..]));
            got.push_str(&s.finish());
            assert_eq!(got, text, "cut at {cut}");
            assert!(s.pending().is_empty(), "pending left at cut {cut}");
        }
    }

    #[test]
    fn survives_every_split_point_ascii() {
        assert_split_invariant("hello, pin shell!\r\n");
    }

    #[test]
    fn survives_every_split_point_cjk_and_emoji() {
        assert_split_invariant("提示符就绪 ✅ 终端 🚀 vim");
    }

    #[test]
    fn byte_at_a_time() {
        let text = "中文🚀ab";
        let mut s = Utf8Stream::new();
        let mut got = String::new();
        for b in text.as_bytes() {
            got.push_str(&s.push(std::slice::from_ref(b)));
        }
        got.push_str(&s.finish());
        assert_eq!(got, text);
    }

    #[test]
    fn invalid_byte_becomes_one_replacement() {
        let mut s = Utf8Stream::new();
        // 0x80 是孤立的续字节
        let got = format!("{}", s.push(b"a\x80b"));
        assert_eq!(got, "a\u{FFFD}b");
        assert!(s.pending().is_empty());
    }

    #[test]
    fn invalid_byte_does_not_swallow_following_text() {
        let mut s = Utf8Stream::new();
        let mut got = s.push(b"\xff\xfe");
        got.push_str(&s.push(b"ok"));
        assert!(got.ends_with("ok"), "got {got:?}");
    }

    #[test]
    fn incomplete_tail_is_held_then_emitted_on_finish() {
        let mut s = Utf8Stream::new();
        let bytes = "终".as_bytes();
        assert_eq!(s.push(&bytes[..2]), "");
        assert_eq!(s.pending().len(), 2);
        assert_eq!(s.finish(), "\u{FFFD}");
        assert!(s.pending().is_empty());
        assert_eq!(s.finish(), "");
    }
}
