//! 尺寸下发：同一尺寸只往 PTY 发一次。
//!
//! 为什么必须去重：ConPTY 每收到一次 `ResizePseudoConsole`（**哪怕 cols/rows 没变**）
//! 都会整屏重绘它自己的屏幕缓冲——把当前视口的内容重新写一遍。终端这侧刚被清空的屏幕
//! 于是又出现了旧内容（复现：暂停 → 清屏 → 继续，`resyncScreen` 末尾那次 resize 触发重绘）。
//!
//! 所以「重新附着 / 继续」这类动作不该顺手 resize：只有真实尺寸变化才下发。
//! 这里只做纯比较，读写 PTY 在 `src-tauri/src/main.rs`。

/// 记录最近一次已经下发（或开局就生效）的尺寸。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SentSize {
    last: Option<(u16, u16)>,
}

impl SentSize {
    /// 还没发过任何尺寸。
    pub fn new() -> Self {
        Self { last: None }
    }

    /// 拉起会话时 PTY 就按这个尺寸开了：记下来，别让第一次附着再发一遍。
    pub fn seeded(cols: u16, rows: u16) -> Self {
        Self {
            last: Some((cols, rows)),
        }
    }

    /// 这个尺寸需要下发吗？需要就返回它并记住；与上次相同时返回 `None`。
    pub fn accept(&mut self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        let want = (cols, rows);
        if self.last == Some(want) {
            return None;
        }
        self.last = Some(want);
        Some(want)
    }

    /// 最近一次生效的尺寸（诊断用）。
    pub fn last(&self) -> Option<(u16, u16)> {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::SentSize;

    #[test]
    fn first_size_is_always_sent() {
        let mut size = SentSize::new();
        assert_eq!(size.accept(120, 40), Some((120, 40)));
        assert_eq!(size.last(), Some((120, 40)));
    }

    #[test]
    fn the_same_size_is_not_sent_again() {
        // 重新附着 / 继续时前端会再报一次同样的尺寸：不下发，否则 ConPTY 整屏重绘
        let mut size = SentSize::seeded(120, 40);
        assert_eq!(size.accept(120, 40), None);
        assert_eq!(size.accept(120, 40), None);
    }

    #[test]
    fn a_real_change_is_sent_once() {
        let mut size = SentSize::seeded(120, 40);
        assert_eq!(size.accept(100, 30), Some((100, 30)));
        assert_eq!(size.accept(100, 30), None);
        // 变回去也算一次变化
        assert_eq!(size.accept(120, 40), Some((120, 40)));
    }

    #[test]
    fn both_dimensions_participate() {
        let mut size = SentSize::seeded(120, 40);
        assert_eq!(size.accept(120, 41), Some((120, 41)));
        assert_eq!(size.accept(119, 41), Some((119, 41)));
        assert_eq!(size.accept(119, 41), None);
    }

    #[test]
    fn one_dimension_changing_alone_is_a_change() {
        // 只改行数（拉高窗口）也必须下发：否则 Shell 的换行位置会错
        let mut size = SentSize::seeded(80, 24);
        assert_eq!(size.accept(80, 30), Some((80, 30)));
    }
}
