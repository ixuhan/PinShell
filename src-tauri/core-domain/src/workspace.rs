//! 工作区与分格布局：窗口是视图，会话是数据（ADR 0004）。
//!
//! 这里只放**纯数据与规则**：窗口、二叉分格树、会话元数据，以及
//! 「哪些形状算合法」的校验与几个编辑操作。序列化、文件 IO、焦点与渲染都不在这里。
//!
//! 三条不变量：
//! 1. 一个会话同一时刻最多出现在一个分格里；
//! 2. 分格树的嵌套不超过 [`MAX_SPLIT_DEPTH`] 层；
//! 3. 窗口里至少要有一个分格（最后一个分格关闭时整个窗口消失）。

use crate::ownership::TransportKind;

/// 分格的最大嵌套层数：再深每一格就小到不可用，改为拖出去开新窗口。
pub const MAX_SPLIT_DEPTH: u8 = 3;

/// 切割比例的可用区间。超出区间的请求被夹到这个区间，而不是拒绝。
pub const MIN_RATIO: f32 = 0.1;
pub const MAX_RATIO: f32 = 0.9;

/// 会话标题的最大长度，按**字符**数（不是字节）算：中文与 emoji 都不能被切一半。
pub const MAX_TITLE_CHARS: usize = 40;

/// 切割方向：`Horizontal` 是左右并排（竖线切），`Vertical` 是上下叠（横线切）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// 窗口内的二叉分格树。叶子是一个分格，叶子里放会话 id。
#[derive(Debug, Clone, PartialEq)]
pub enum Layout {
    Leaf {
        session: String,
    },
    Split {
        axis: Axis,
        ratio: f32,
        first: Box<Layout>,
        second: Box<Layout>,
    },
}

impl Layout {
    pub fn leaf(session: impl Into<String>) -> Self {
        Layout::Leaf {
            session: session.into(),
        }
    }

    /// 从左到右、从上到下的叶子顺序，UI 直接用这个顺序排 tab 或做 Tab 键轮转。
    pub fn leaves(&self) -> Vec<&str> {
        let mut out = Vec::new();
        self.collect_leaves(&mut out);
        out
    }

    fn collect_leaves<'a>(&'a self, out: &mut Vec<&'a str>) {
        match self {
            Layout::Leaf { session } => out.push(session),
            Layout::Split { first, second, .. } => {
                first.collect_leaves(out);
                second.collect_leaves(out);
            }
        }
    }

    pub fn contains(&self, session: &str) -> bool {
        match self {
            Layout::Leaf { session: s } => s == session,
            Layout::Split { first, second, .. } => {
                first.contains(session) || second.contains(session)
            }
        }
    }

    /// 最深叶子的分裂层数：单个叶子是 0，每多一层切分加一。
    pub fn depth(&self) -> u8 {
        match self {
            Layout::Leaf { .. } => 0,
            Layout::Split { first, second, .. } => 1 + first.depth().max(second.depth()),
        }
    }
}

/// 会话元数据。热/冷只是内存态标记，落盘后一律按冷会话读回。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub transport: TransportKind,
    pub cwd: Option<String>,
    /// 终端通道才有；串口会话为 `None`
    pub shell: Option<String>,
    pub hot: bool,
}

impl SessionMeta {
    pub fn terminal(id: impl Into<String>, title: impl Into<String>, shell: impl Into<String>) -> Self {
        SessionMeta {
            id: id.into(),
            title: title.into(),
            transport: TransportKind::Terminal,
            cwd: None,
            shell: Some(shell.into()),
            hot: false,
        }
    }

    pub fn serial(id: impl Into<String>, title: impl Into<String>) -> Self {
        SessionMeta {
            id: id.into(),
            title: title.into(),
            transport: TransportKind::Serial,
            cwd: None,
            shell: None,
            hot: false,
        }
    }
}

/// 窗口的位置与尺寸（逻辑像素）。多显示器与吸附组留到窗口组落地时再加。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: u64,
    pub rect: Rect,
    /// 一定非空：窗口里至少有一个分格
    pub layout: Layout,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub windows: Vec<Window>,
    pub sessions: Vec<SessionMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceError {
    DuplicateSession(String),
    UnknownSession(String),
    SessionAlreadyPlaced(String),
    SessionNotPlaced(String),
    WindowNotFound(u64),
    /// 空标题没有意义，也没有可回退的显示文本
    InvalidTitle,
    /// 跨窗口交换不是布局操作：迁移会话要走「移动」，不是交换
    CrossWindowSwap,
    TooDeep,
    InvalidRatio,
    /// 从文件读回来的形状不合法：空窗口、重复放置、悬空引用等
    Corrupt(String),
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            windows: Vec::new(),
            sessions: Vec::new(),
        }
    }

    pub fn session(&self, id: &str) -> Option<&SessionMeta> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn session_mut(&mut self, id: &str) -> Option<&mut SessionMeta> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn window(&self, id: u64) -> Option<&Window> {
        self.windows.iter().find(|w| w.id == id)
    }

    /// 注册会话元数据（冷会话也能注册）。不放到任何分格里。
    pub fn add_session(&mut self, meta: SessionMeta) -> Result<(), WorkspaceError> {
        if self.session(&meta.id).is_some() {
            return Err(WorkspaceError::DuplicateSession(meta.id));
        }
        self.sessions.push(meta);
        Ok(())
    }

    pub fn set_hot(&mut self, id: &str, hot: bool) -> Result<(), WorkspaceError> {
        let session = self
            .session_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownSession(id.to_string()))?;
        session.hot = hot;
        Ok(())
    }

    /// 跟随 Shell 上报的工作目录。返回是否真的变了：调用方只在变了时落盘，
    /// 否则每次回车都会重写一遍 workspace.json。
    pub fn set_cwd(&mut self, id: &str, cwd: impl Into<String>) -> Result<bool, WorkspaceError> {
        let session = self
            .session_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownSession(id.to_string()))?;
        let cwd = cwd.into();
        if session.cwd.as_deref() == Some(cwd.as_str()) {
            return Ok(false);
        }
        session.cwd = Some(cwd);
        Ok(true)
    }

    /// 改会话标题。首尾空白会被去掉，超过 [`MAX_TITLE_CHARS`] 的部分按字符截断，
    /// 全空白视为非法。返回是否真的变了，调用方据此决定要不要落盘。
    pub fn rename_session(&mut self, id: &str, title: &str) -> Result<bool, WorkspaceError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(WorkspaceError::InvalidTitle);
        }
        let next: String = trimmed.chars().take(MAX_TITLE_CHARS).collect();
        let session = self
            .session_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownSession(id.to_string()))?;
        if session.title == next {
            return Ok(false);
        }
        session.title = next;
        Ok(true)
    }

    /// 会话在哪个窗口里。冷会话（没有分格）返回 `None`。
    pub fn window_of(&self, session: &str) -> Option<u64> {
        self.windows
            .iter()
            .find(|w| w.layout.contains(session))
            .map(|w| w.id)
    }

    /// 新开一个窗口并放入会话。
    pub fn open(&mut self, session: &str, rect: Rect) -> Result<u64, WorkspaceError> {
        self.ensure_session(session)?;
        if self.window_of(session).is_some() {
            return Err(WorkspaceError::SessionAlreadyPlaced(session.to_string()));
        }
        let id = self.next_window_id();
        self.windows.push(Window {
            id,
            rect,
            layout: Layout::leaf(session),
        });
        Ok(id)
    }

    /// 在 `target` 所在分格旁边切开，把 `new_session` 放进第二格。
    pub fn split(
        &mut self,
        target: &str,
        new_session: &str,
        axis: Axis,
        ratio: f32,
    ) -> Result<(), WorkspaceError> {
        self.ensure_session(new_session)?;
        if self.window_of(new_session).is_some() {
            return Err(WorkspaceError::SessionAlreadyPlaced(
                new_session.to_string(),
            ));
        }
        let window = self
            .windows
            .iter_mut()
            .find(|w| w.layout.contains(target))
            .ok_or_else(|| WorkspaceError::SessionNotPlaced(target.to_string()))?;

        let depth = depth_to(&window.layout, target)
            .ok_or_else(|| WorkspaceError::SessionNotPlaced(target.to_string()))?;
        if depth + 1 > MAX_SPLIT_DEPTH {
            return Err(WorkspaceError::TooDeep);
        }

        let ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        let split = split_leaf(&window.layout, target, axis, ratio, new_session)
            .ok_or_else(|| WorkspaceError::SessionNotPlaced(target.to_string()))?;
        window.layout = split;
        Ok(())
    }

    /// 关闭会话：移出分格（折叠父切割），并删除会话元数据。历史库不在这里（I2）。
    /// 最后一个分格关闭时窗口一起消失（ADR 0004）。
    pub fn close_session(&mut self, session: &str) -> Result<CloseOutcome, WorkspaceError> {
        let known = self.session(session).is_some() || self.window_of(session).is_some();
        if !known {
            return Err(WorkspaceError::UnknownSession(session.to_string()));
        }

        self.sessions.retain(|s| s.id != session);
        let mut window_closed = None;
        let mut idx = 0;
        while idx < self.windows.len() {
            if !self.windows[idx].layout.contains(session) {
                idx += 1;
                continue;
            }
            match remove_leaf(self.windows[idx].layout.clone(), session) {
                Some(layout) => self.windows[idx].layout = layout,
                None => {
                    window_closed = Some(self.windows[idx].id);
                    self.windows.remove(idx);
                }
            }
        }
        Ok(CloseOutcome { window_closed })
    }

    /// 交换两个分格里的会话（拖到已占用的分格上时用交换而不是替换）。
    pub fn swap(&mut self, a: &str, b: &str) -> Result<(), WorkspaceError> {
        if a == b {
            return Ok(());
        }
        let (Some(wa), Some(wb)) = (self.window_of(a), self.window_of(b)) else {
            let missing = if self.window_of(a).is_none() { a } else { b };
            return Err(WorkspaceError::SessionNotPlaced(missing.to_string()));
        };
        if wa != wb {
            return Err(WorkspaceError::CrossWindowSwap);
        }
        let window = self
            .windows
            .iter_mut()
            .find(|w| w.id == wa)
            .ok_or(WorkspaceError::WindowNotFound(wa))?;
        swap_leaves(&mut window.layout, a, b);
        Ok(())
    }

    /// 结构校验：唯一性、悬空引用、重复放置、深度与比例。
    pub fn validate(&self) -> Result<(), WorkspaceError> {
        let mut seen_sessions = std::collections::HashSet::new();
        for s in &self.sessions {
            if !seen_sessions.insert(s.id.as_str()) {
                return Err(WorkspaceError::DuplicateSession(s.id.clone()));
            }
        }

        let mut seen_windows = std::collections::HashSet::new();
        let mut placed = std::collections::HashSet::new();
        for window in &self.windows {
            if !seen_windows.insert(window.id) {
                return Err(WorkspaceError::Corrupt(format!(
                    "duplicate window id {}",
                    window.id
                )));
            }
            check_layout(&window.layout, &self.sessions, &mut placed)?;
        }
        Ok(())
    }

    fn ensure_session(&self, id: &str) -> Result<(), WorkspaceError> {
        if self.session(id).is_none() {
            return Err(WorkspaceError::UnknownSession(id.to_string()));
        }
        Ok(())
    }

    fn next_window_id(&self) -> u64 {
        self.windows.iter().map(|w| w.id).max().unwrap_or(0) + 1
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseOutcome {
    /// 最后一个分格被关掉时，该窗口的 id
    pub window_closed: Option<u64>,
}

fn depth_to(layout: &Layout, session: &str) -> Option<u8> {
    match layout {
        Layout::Leaf { session: s } => (s == session).then_some(0),
        Layout::Split { first, second, .. } => depth_to(first, session)
            .or_else(|| depth_to(second, session))
            .map(|d| d + 1),
    }
}

fn split_leaf(
    layout: &Layout,
    target: &str,
    axis: Axis,
    ratio: f32,
    new_session: &str,
) -> Option<Layout> {
    match layout {
        Layout::Leaf { session } if session == target => Some(Layout::Split {
            axis,
            ratio,
            first: Box::new(Layout::Leaf {
                session: session.clone(),
            }),
            second: Box::new(Layout::leaf(new_session)),
        }),
        Layout::Leaf { .. } => None,
        Layout::Split {
            axis: a,
            ratio: r,
            first,
            second,
        } => {
            if let Some(next) = split_leaf(first, target, axis, ratio, new_session) {
                return Some(Layout::Split {
                    axis: *a,
                    ratio: *r,
                    first: Box::new(next),
                    second: second.clone(),
                });
            }
            let next = split_leaf(second, target, axis, ratio, new_session)?;
            Some(Layout::Split {
                axis: *a,
                ratio: *r,
                first: first.clone(),
                second: Box::new(next),
            })
        }
    }
}

/// 删掉一个叶子并折叠它的父切割；返回 `None` 表示整棵树空了。
fn remove_leaf(layout: Layout, session: &str) -> Option<Layout> {
    match layout {
        Layout::Leaf { session: s } => {
            if s == session {
                None
            } else {
                Some(Layout::Leaf { session: s })
            }
        }
        Layout::Split {
            axis,
            ratio,
            first,
            second,
        } => match (
            remove_leaf(*first, session),
            remove_leaf(*second, session),
        ) {
            (None, None) => None,
            (None, Some(rest)) => Some(rest),
            (Some(rest), None) => Some(rest),
            (Some(a), Some(b)) => Some(Layout::Split {
                axis,
                ratio,
                first: Box::new(a),
                second: Box::new(b),
            }),
        },
    }
}

fn swap_leaves(layout: &mut Layout, a: &str, b: &str) {
    match layout {
        Layout::Leaf { session } => {
            if session == a {
                *session = b.to_string();
            } else if session == b {
                *session = a.to_string();
            }
        }
        Layout::Split { first, second, .. } => {
            swap_leaves(first, a, b);
            swap_leaves(second, a, b);
        }
    }
}

fn check_layout(
    layout: &Layout,
    sessions: &[SessionMeta],
    placed: &mut std::collections::HashSet<String>,
) -> Result<(), WorkspaceError> {
    if layout.depth() > MAX_SPLIT_DEPTH {
        return Err(WorkspaceError::TooDeep);
    }
    match layout {
        Layout::Leaf { session } => {
            if !sessions.iter().any(|s| &s.id == session) {
                return Err(WorkspaceError::UnknownSession(session.clone()));
            }
            if !placed.insert(session.clone()) {
                return Err(WorkspaceError::SessionAlreadyPlaced(session.clone()));
            }
            Ok(())
        }
        Layout::Split {
            ratio, first, second, ..
        } => {
            if !(*ratio > 0.0 && *ratio < 1.0) {
                return Err(WorkspaceError::InvalidRatio);
            }
            check_layout(first, sessions, placed)?;
            check_layout(second, sessions, placed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> Rect {
        Rect::new(0.0, 0.0, 1200.0, 800.0)
    }

    fn workspace_with(ids: &[&str]) -> Workspace {
        let mut ws = Workspace::new();
        for id in ids {
            ws.add_session(SessionMeta::terminal(*id, *id, "pwsh.exe"))
                .unwrap();
        }
        ws
    }

    #[test]
    fn open_places_session_in_a_single_pane() {
        let mut ws = workspace_with(&["a"]);
        let w = ws.open("a", rect()).unwrap();
        let window = ws.window(w).unwrap();
        assert_eq!(window.layout, Layout::leaf("a"));
        assert_eq!(ws.window_of("a"), Some(w));
        assert_eq!(ws.window_of("missing"), None);
    }

    #[test]
    fn split_puts_the_new_session_after_the_target() {
        let mut ws = workspace_with(&["a", "b", "c"]);
        let w = ws.open("a", rect()).unwrap();
        ws.split("a", "b", Axis::Horizontal, 0.5).unwrap();
        ws.split("a", "c", Axis::Vertical, 0.3).unwrap();
        let layout = &ws.window(w).unwrap().layout;
        assert_eq!(layout.leaves(), vec!["a", "c", "b"]);
        assert_eq!(layout.depth(), 2);
        assert!(layout.contains("c"));
    }

    #[test]
    fn split_refuses_a_fourth_level_and_leaves_the_tree_untouched() {
        let mut ws = workspace_with(&["a", "b", "c", "d", "e"]);
        let w = ws.open("a", rect()).unwrap();
        ws.split("a", "b", Axis::Horizontal, 0.5).unwrap();
        ws.split("a", "c", Axis::Horizontal, 0.5).unwrap();
        ws.split("a", "d", Axis::Horizontal, 0.5).unwrap();
        let before = ws.window(w).unwrap().layout.clone();

        assert_eq!(
            ws.split("a", "e", Axis::Horizontal, 0.5),
            Err(WorkspaceError::TooDeep)
        );
        assert_eq!(ws.window(w).unwrap().layout, before);
        assert_eq!(ws.window_of("e"), None);
    }

    #[test]
    fn split_clamps_the_ratio_instead_of_rejecting_it() {
        let mut ws = workspace_with(&["a", "b"]);
        let w = ws.open("a", rect()).unwrap();
        ws.split("a", "b", Axis::Horizontal, 5.0).unwrap();
        match &ws.window(w).unwrap().layout {
            Layout::Split { ratio, .. } => assert!((*ratio - MAX_RATIO).abs() < f32::EPSILON),
            other => panic!("expected a split, got {other:?}"),
        }
        ws.validate().unwrap();
    }

    #[test]
    fn split_needs_both_sessions_known_and_new_one_unplaced() {
        let mut ws = workspace_with(&["a", "b"]);
        ws.open("a", rect()).unwrap();

        assert_eq!(
            ws.split("a", "ghost", Axis::Horizontal, 0.5),
            Err(WorkspaceError::UnknownSession("ghost".into()))
        );
        assert_eq!(
            ws.split("ghost", "b", Axis::Horizontal, 0.5),
            Err(WorkspaceError::SessionNotPlaced("ghost".into()))
        );
        ws.open("b", rect()).unwrap();
        assert_eq!(
            ws.split("a", "b", Axis::Horizontal, 0.5),
            Err(WorkspaceError::SessionAlreadyPlaced("b".into()))
        );
    }

    #[test]
    fn closing_a_pane_collapses_its_parent_split() {
        let mut ws = workspace_with(&["a", "b", "c"]);
        let w = ws.open("a", rect()).unwrap();
        ws.split("a", "b", Axis::Horizontal, 0.5).unwrap();
        ws.split("b", "c", Axis::Horizontal, 0.5).unwrap();

        let outcome = ws.close_session("b").unwrap();
        assert_eq!(outcome.window_closed, None);
        assert_eq!(ws.window(w).unwrap().layout.leaves(), vec!["a", "c"]);
        assert_eq!(ws.window(w).unwrap().layout.depth(), 1);
        assert!(ws.session("b").is_none());
        ws.validate().unwrap();
    }

    #[test]
    fn closing_the_last_pane_closes_the_window() {
        let mut ws = workspace_with(&["a"]);
        let w = ws.open("a", rect()).unwrap();
        let outcome = ws.close_session("a").unwrap();
        assert_eq!(outcome.window_closed, Some(w));
        assert!(ws.windows.is_empty());
        assert!(ws.sessions.is_empty());
    }

    #[test]
    fn closing_a_cold_session_only_drops_metadata() {
        let mut ws = workspace_with(&["cold"]);
        let outcome = ws.close_session("cold").unwrap();
        assert_eq!(outcome.window_closed, None);
        assert!(ws.sessions.is_empty());
        assert_eq!(
            ws.close_session("cold"),
            Err(WorkspaceError::UnknownSession("cold".into()))
        );
    }

    #[test]
    fn swap_exchanges_sessions_inside_one_window() {
        let mut ws = workspace_with(&["a", "b", "c"]);
        let w = ws.open("a", rect()).unwrap();
        ws.split("a", "b", Axis::Horizontal, 0.5).unwrap();

        ws.swap("a", "b").unwrap();
        assert_eq!(ws.window(w).unwrap().layout.leaves(), vec!["b", "a"]);
        ws.swap("a", "a").unwrap();
        assert_eq!(
            ws.swap("a", "c"),
            Err(WorkspaceError::SessionNotPlaced("c".into()))
        );
    }

    #[test]
    fn swap_across_windows_is_refused() {
        let mut ws = workspace_with(&["a", "b"]);
        ws.open("a", rect()).unwrap();
        ws.open("b", rect()).unwrap();
        assert_eq!(ws.swap("a", "b"), Err(WorkspaceError::CrossWindowSwap));
    }

    #[test]
    fn hot_flag_is_memory_only_and_checked_against_existing_sessions() {
        let mut ws = workspace_with(&["a"]);
        assert!(!ws.session("a").unwrap().hot);
        ws.set_hot("a", true).unwrap();
        assert!(ws.session("a").unwrap().hot);
        assert_eq!(
            ws.set_hot("ghost", true),
            Err(WorkspaceError::UnknownSession("ghost".into()))
        );
    }

    #[test]
    fn validate_rejects_duplicate_session_ids() {
        let mut ws = workspace_with(&["a"]);
        ws.sessions
            .push(SessionMeta::terminal("a", "a again", "pwsh.exe"));
        assert_eq!(
            ws.validate(),
            Err(WorkspaceError::DuplicateSession("a".into()))
        );
    }

    #[test]
    fn validate_rejects_dangling_and_twice_placed_sessions() {
        let mut ws = workspace_with(&["a"]);
        ws.windows.push(Window {
            id: 1,
            rect: rect(),
            layout: Layout::leaf("ghost"),
        });
        assert_eq!(
            ws.validate(),
            Err(WorkspaceError::UnknownSession("ghost".into()))
        );

        let mut twice = workspace_with(&["a"]);
        twice.windows.push(Window {
            id: 1,
            rect: rect(),
            layout: Layout::Split {
                axis: Axis::Horizontal,
                ratio: 0.5,
                first: Box::new(Layout::leaf("a")),
                second: Box::new(Layout::leaf("a")),
            },
        });
        assert_eq!(
            twice.validate(),
            Err(WorkspaceError::SessionAlreadyPlaced("a".into()))
        );
    }

    #[test]
    fn validate_rejects_out_of_range_ratio_and_too_deep_tree() {
        let mut ws = workspace_with(&["a", "b"]);
        ws.windows.push(Window {
            id: 1,
            rect: rect(),
            layout: Layout::Split {
                axis: Axis::Horizontal,
                ratio: 1.5,
                first: Box::new(Layout::leaf("a")),
                second: Box::new(Layout::leaf("b")),
            },
        });
        assert_eq!(ws.validate(), Err(WorkspaceError::InvalidRatio));

        // 四层嵌套：深度 4 > MAX_SPLIT_DEPTH
        let mut nested = Layout::leaf("a");
        for id in ["b", "c", "d", "e"] {
            nested = Layout::Split {
                axis: Axis::Vertical,
                ratio: 0.5,
                first: Box::new(nested),
                second: Box::new(Layout::leaf(id)),
            };
        }
        let ws = Workspace {
            windows: vec![Window {
                id: 1,
                rect: rect(),
                layout: nested,
            }],
            sessions: ["a", "b", "c", "d", "e"]
                .iter()
                .map(|id| SessionMeta::terminal(*id, *id, "pwsh.exe"))
                .collect(),
        };
        assert_eq!(ws.validate(), Err(WorkspaceError::TooDeep));
    }

    #[test]
    fn set_cwd_reports_only_real_changes() {
        let mut ws = workspace_with(&["a"]);
        assert_eq!(ws.set_cwd("a", "C:/Users/me"), Ok(true));
        assert_eq!(
            ws.session("a").unwrap().cwd.as_deref(),
            Some("C:/Users/me")
        );
        // 同一个目录反复上报（每次提示符都会来一条）不算变更，调用方据此跳过落盘
        assert_eq!(ws.set_cwd("a", "C:/Users/me"), Ok(false));
        assert_eq!(ws.set_cwd("a", "D:/work"), Ok(true));
        assert_eq!(ws.session("a").unwrap().cwd.as_deref(), Some("D:/work"));
        assert_eq!(
            ws.set_cwd("missing", "C:/"),
            Err(WorkspaceError::UnknownSession("missing".into()))
        );
    }

    #[test]
    fn rename_trims_truncates_and_rejects_blank() {
        let mut ws = workspace_with(&["a"]);
        assert_eq!(ws.rename_session("a", "  部署窗口  "), Ok(true));
        assert_eq!(ws.session("a").unwrap().title, "部署窗口");
        // 同一个名字再改一次不算变更
        assert_eq!(ws.rename_session("a", "部署窗口"), Ok(false));
        // 全空白没有可显示的内容
        assert_eq!(ws.rename_session("a", "   "), Err(WorkspaceError::InvalidTitle));
        // 按字符截断：中文与 emoji 都不会被切半个
        let long = "配".repeat(30) + &"🚀".repeat(20);
        assert_eq!(ws.rename_session("a", &long), Ok(true));
        let title = ws.session("a").unwrap().title.clone();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(title, "配".repeat(30) + &"🚀".repeat(10));
        assert_eq!(
            ws.rename_session("missing", "x"),
            Err(WorkspaceError::UnknownSession("missing".into()))
        );
    }
}

