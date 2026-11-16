//! 输入所有权：决定这一瞬间按键归谁。
//!
//! 规则来自 `docs/adr/0003-input-ownership.md`：判定按通道类型，不看 UI 状态点。
//! 终端：备用屏 > 提示符就绪 > 运行中 > 未知；只有「确知就绪」才归输入条。
//! 串口：恒归输入条（不存在第二个消费按键的进程）。

use crate::osc::OscEvent;

/// 通道类型。新增通道时必须先回答「谁在跟输入条抢按键」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Terminal,
    Serial,
}

/// 终端通道的状态。`PromptGuess` 只驱动提示，永不接管按键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalState {
    Unknown,
    PromptGuess,
    PromptReady,
    Running,
    AltScreen,
}

/// 用户的显式覆盖，优先级最高。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Override {
    None,
    /// 用户显式锁定输入条接管（即使状态机说运行中也不交还）
    ForceInputBar,
    /// 用户显式切直通
    ForcePassthrough,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    InputBar,
    Channel,
}

/// 这个判定是「确知」还是「猜的」。UI 的状态点必须能区分两者。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Certain,
    Guess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub owner: Owner,
    pub confidence: Confidence,
}

/// 判定按键归属。这是唯一决定按键去向的函数。
pub fn decide(kind: TransportKind, state: TerminalState, ovr: Override) -> Decision {
    let decision = |owner, confidence| Decision { owner, confidence };

    match ovr {
        Override::ForceInputBar => return decision(Owner::InputBar, Confidence::Certain),
        Override::ForcePassthrough => return decision(Owner::Channel, Confidence::Certain),
        Override::None => {}
    }

    match kind {
        TransportKind::Serial => decision(Owner::InputBar, Confidence::Certain),
        TransportKind::Terminal => match state {
            TerminalState::PromptReady => decision(Owner::InputBar, Confidence::Certain),
            // 猜测永不抢键
            TerminalState::PromptGuess => decision(Owner::Channel, Confidence::Guess),
            TerminalState::Running | TerminalState::Unknown | TerminalState::AltScreen => {
                decision(Owner::Channel, Confidence::Certain)
            }
        },
    }
}

/// 静默多久之后允许出现「猜测」。
pub const PROMPT_GUESS_AFTER_MS: u64 = 1200;

/// 这次写入是不是「用户在提交一行」。
///
/// 输入条和直通模式最后都走同一个写入接口，所以判定只能看字节：
/// 以回车（`\r`）或换行（`\n`）结尾就是提交。方向键、Ctrl+C 之类的控制串不算。
pub fn is_submit(data: &str) -> bool {
    data.ends_with('\r') || data.ends_with('\n')
}

/// 把标记流推进成状态。纯状态机：没有时钟、没有 IO，时间以参数传入。
#[derive(Debug, Clone)]
pub struct PromptTracker {
    base: TerminalState,
    guess: bool,
}

impl Default for PromptTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl PromptTracker {
    pub fn new() -> Self {
        Self {
            base: TerminalState::Unknown,
            guess: false,
        }
    }

    /// 状态机的底层状态（不含猜测）。
    pub fn base_state(&self) -> TerminalState {
        self.base
    }

    /// 送去判定时使用的状态（猜测会被展开成 `PromptGuess`）。
    pub fn view(&self) -> TerminalState {
        if self.guess {
            TerminalState::PromptGuess
        } else {
            self.base
        }
    }

    pub fn on_event(&mut self, ev: &OscEvent) {
        self.guess = false;
        match ev {
            OscEvent::PromptStart => self.base = TerminalState::PromptReady,
            OscEvent::CommandStart => self.base = TerminalState::Running,
            // 命令结束到提示符真正画出之间，没有第二个进程在抢按键
            OscEvent::CommandEnd { .. } => self.base = TerminalState::PromptReady,
            OscEvent::AltScreen { entered: true } => self.base = TerminalState::AltScreen,
            // 谁退出备用屏无从得知，只能回到未知
            OscEvent::AltScreen { entered: false } => self.base = TerminalState::Unknown,
            _ => {}
        }
    }

    /// 用户按了回车。立刻视为运行中（比「等 N 毫秒」更保守，且不会误抢键）。
    ///
    /// 备用屏例外：全屏程序（vim/less）自己消费回车，状态不能被拽回 Running，
    /// 否则退出全屏时状态机的起点就错了。
    pub fn on_submit(&mut self) {
        if self.base == TerminalState::AltScreen {
            return;
        }
        self.guess = false;
        self.base = TerminalState::Running;
    }

    /// 长时间没有输出时的启发式：只有「未知」状态才允许出现猜测。
    pub fn on_silence(&mut self, quiet_ms: u64, at_line_start: bool) {
        self.guess = self.base == TerminalState::Unknown
            && at_line_start
            && quiet_ms >= PROMPT_GUESS_AFTER_MS;
    }

    pub fn reset(&mut self) {
        self.base = TerminalState::Unknown;
        self.guess = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(kind: TransportKind, state: TerminalState) -> Owner {
        decide(kind, state, Override::None).owner
    }

    #[test]
    fn terminal_only_prompt_ready_takes_keys() {
        assert_eq!(
            owner(TransportKind::Terminal, TerminalState::PromptReady),
            Owner::InputBar
        );
        for state in [
            TerminalState::Unknown,
            TerminalState::Running,
            TerminalState::AltScreen,
            TerminalState::PromptGuess,
        ] {
            assert_eq!(
                owner(TransportKind::Terminal, state),
                Owner::Channel,
                "{state:?} must pass keys through"
            );
        }
    }

    #[test]
    fn guess_is_marked_but_still_passes_keys() {
        let d = decide(
            TransportKind::Terminal,
            TerminalState::PromptGuess,
            Override::None,
        );
        assert_eq!(d.owner, Owner::Channel);
        assert_eq!(d.confidence, Confidence::Guess);

        let d = decide(
            TransportKind::Terminal,
            TerminalState::PromptReady,
            Override::None,
        );
        assert_eq!(d.confidence, Confidence::Certain);
    }

    #[test]
    fn serial_always_input_bar() {
        for state in [
            TerminalState::Unknown,
            TerminalState::PromptReady,
            TerminalState::Running,
            TerminalState::AltScreen,
            TerminalState::PromptGuess,
        ] {
            assert_eq!(
                decide(TransportKind::Serial, state, Override::None).owner,
                Owner::InputBar,
                "{state:?}"
            );
        }
    }

    #[test]
    fn explicit_override_wins() {
        // 锁定：即使运行中也归输入条
        assert_eq!(
            decide(
                TransportKind::Terminal,
                TerminalState::Running,
                Override::ForceInputBar
            )
            .owner,
            Owner::InputBar
        );
        // 直通：即使确知就绪也归通道
        assert_eq!(
            decide(
                TransportKind::Terminal,
                TerminalState::PromptReady,
                Override::ForcePassthrough
            )
            .owner,
            Owner::Channel
        );
        // 覆盖状态下的判定都是确知
        assert_eq!(
            decide(
                TransportKind::Terminal,
                TerminalState::Unknown,
                Override::ForceInputBar
            )
            .confidence,
            Confidence::Certain
        );
    }

    #[test]
    fn tracker_follows_markers() {
        let mut t = PromptTracker::new();
        assert_eq!(t.view(), TerminalState::Unknown);

        t.on_event(&OscEvent::PromptStart);
        assert_eq!(t.view(), TerminalState::PromptReady);

        t.on_event(&OscEvent::PromptEnd);
        assert_eq!(t.view(), TerminalState::PromptReady);

        t.on_event(&OscEvent::CommandStart);
        assert_eq!(t.view(), TerminalState::Running);

        t.on_event(&OscEvent::CommandEnd { code: Some(0) });
        assert_eq!(t.view(), TerminalState::PromptReady);
    }

    #[test]
    fn alt_screen_beats_ready_and_returns_to_unknown() {
        let mut t = PromptTracker::new();
        t.on_event(&OscEvent::PromptStart);
        t.on_event(&OscEvent::AltScreen { entered: true });
        assert_eq!(t.view(), TerminalState::AltScreen);
        assert_eq!(
            decide(TransportKind::Terminal, t.view(), Override::None).owner,
            Owner::Channel
        );

        t.on_event(&OscEvent::AltScreen { entered: false });
        assert_eq!(t.view(), TerminalState::Unknown);
        // 退出全屏之后不能擅自回到「就绪」
        assert_eq!(
            decide(TransportKind::Terminal, t.view(), Override::None).owner,
            Owner::Channel
        );
    }

    #[test]
    fn submit_moves_to_running_immediately() {
        let mut t = PromptTracker::new();
        t.on_event(&OscEvent::PromptStart);
        t.on_submit();
        assert_eq!(t.view(), TerminalState::Running);
        assert_eq!(
            decide(TransportKind::Terminal, t.view(), Override::None).owner,
            Owner::Channel
        );
    }

    #[test]
    fn submit_in_alt_screen_stays_alt_screen() {
        // 全屏程序里的回车属于程序自己，不能把状态拽回 Running
        let mut t = PromptTracker::new();
        t.on_event(&OscEvent::AltScreen { entered: true });
        t.on_submit();
        assert_eq!(t.view(), TerminalState::AltScreen);
    }

    #[test]
    fn only_line_ending_counts_as_submit() {
        assert!(is_submit("\r"));
        assert!(is_submit("echo hi\r"));
        assert!(is_submit("echo hi\n"));
        // 空写入、方向键、Ctrl+C 都不是提交
        assert!(!is_submit(""));
        assert!(!is_submit("\x1b[A"));
        assert!(!is_submit("\x03"));
        assert!(!is_submit("echo hi"));
        // 行中间的回车也算（粘贴多行时最后一行会执行）
        assert!(is_submit("a\r\nb\r"));
    }

    #[test]
    fn guess_only_when_unknown_and_cleared_by_markers() {
        let mut t = PromptTracker::new();

        // 未知 + 行首 + 静默够久 → 猜测
        t.on_silence(PROMPT_GUESS_AFTER_MS, true);
        assert_eq!(t.view(), TerminalState::PromptGuess);

        // 静默不够久 → 不猜
        t.on_silence(PROMPT_GUESS_AFTER_MS - 1, true);
        assert_eq!(t.view(), TerminalState::Unknown);

        // 不在行首 → 不猜
        t.on_silence(PROMPT_GUESS_AFTER_MS * 3, false);
        assert_eq!(t.view(), TerminalState::Unknown);

        // 收到标记后猜测立刻失效
        t.on_silence(PROMPT_GUESS_AFTER_MS, true);
        t.on_event(&OscEvent::PromptStart);
        assert_eq!(t.view(), TerminalState::PromptReady);

        // 运行中即使长期静默也不猜（静默构建不能抢键）
        t.on_submit();
        t.on_silence(PROMPT_GUESS_AFTER_MS * 10, true);
        assert_eq!(t.view(), TerminalState::Running);
    }

    #[test]
    fn no_integration_script_means_never_ready() {
        // 只有标题、CWD 这类事件时，状态必须停在未知：按键全透传
        let mut t = PromptTracker::new();
        t.on_event(&OscEvent::Title("x".into()));
        t.on_event(&OscEvent::Cwd("C:/x".into()));
        assert_eq!(t.view(), TerminalState::Unknown);
        assert_eq!(
            decide(TransportKind::Terminal, t.view(), Override::None).owner,
            Owner::Channel
        );
    }
}
