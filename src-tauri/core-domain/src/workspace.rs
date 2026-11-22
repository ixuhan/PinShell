//! 工作区与分格布局：项目是会话的唯一容器（ADR 0008）。
//!
//! 这里只放**纯数据与规则**：项目、二叉分格树、会话元数据，以及
//! 「哪些形状算合法」的校验与几个编辑操作。序列化、文件 IO、焦点与渲染都不在这里。
//!
//! 两条不变量（[`Workspace::validate`] 逐条检查）：
//! 1. 会话的 `owner` 指向的项目必须存在；
//! 2. 会话出现在该项目的 layout 里恰好一次。
//!
//! 另有两条形状限制：分格树嵌套不超过 [`MAX_SPLIT_DEPTH`] 层，切割比例夹在 0.1–0.9。
//! 空项目合法：`layout` 为 `None` 就是「关掉最后一格之后留下的空壳」，项目节点仍在，
//! 可以继续投放新会话。

use crate::ownership::TransportKind;
use crate::serial::SerialConfig;
use std::collections::{HashMap, HashSet};

/// 分格的最大嵌套层数：再深每一格就小到不可用。
pub const MAX_SPLIT_DEPTH: u8 = 3;

/// 切割比例的可用区间。超出区间的请求被夹到这个区间，而不是拒绝。
pub const MIN_RATIO: f32 = 0.1;
pub const MAX_RATIO: f32 = 0.9;

/// 会话与项目名称的最大长度，按**字符**数（不是字节）算：中文与 emoji 都不能被切一半。
pub const MAX_TITLE_CHARS: usize = 40;

/// 切割方向：`Horizontal` 是左右并排（竖线切），`Vertical` 是上下叠（横线切）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// 新分格落在目标格的哪一侧。只带轴向表达不了「拖到左/上边缘」，
/// 所以落点用 Side 而不是 Axis；轴向由 Side 推导出来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

impl Side {
    pub fn axis(self) -> Axis {
        match self {
            Side::Left | Side::Right => Axis::Horizontal,
            Side::Top | Side::Bottom => Axis::Vertical,
        }
    }

    /// 新格是否占据切割后的第一个子节点。比例永远描述第一个子节点的占比，
    /// 所以左/上插入时 `ratio` 指的是新格的尺寸。
    fn new_first(self) -> bool {
        matches!(self, Side::Left | Side::Top)
    }
}

/// 项目内的二叉分格树。叶子是一个分格，叶子里放会话 id。
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

    /// 从左到右、从上到下的叶子顺序，UI 直接用这个顺序排分格。
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

    /// 某个会话所在叶子的层数。找不到返回 `None`。
    /// 落点预检要在开进程之前判断「再切一格会不会超过 3 层」，不能等写完布局再拒绝。
    pub fn depth_of(&self, session: &str) -> Option<u8> {
        match self {
            Layout::Leaf { session: s } => (s == session).then_some(0),
            Layout::Split { first, second, .. } => first
                .depth_of(session)
                .or_else(|| second.depth_of(session))
                .map(|depth| depth + 1),
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
    /// 串口通道才有；终端会话为 `None`。
    pub serial: Option<SerialConfig>,
    /// 会话显示与用户日志设置；不改变内部诊断日志。
    pub settings: SessionSettings,
    pub hot: bool,
    /// 归属：会话所属的项目。项目是唯一容器，没有无主会话。
    pub owner: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSettings {
    pub cr_as_newline: bool,
    pub console_timestamps: bool,
    pub file_timestamps: bool,
    pub timestamp_format: String,
    pub log_directory: Option<String>,
    pub log_filename: String,
    pub logging: bool,
    /// 暂停/继续（串口是断开/连接）时换一个新的日志文件。
    /// 默认关闭：一次会话默认写同一个文件，只有用户主动勾选才按连接切分。
    pub new_log_on_toggle: bool,
    /// 终端字号（CSS 像素）。属于会话：不同会话可以各自放大或缩小，
    /// 全局设置里不再有字号项。
    pub font_size: u16,
}

/// 字号的合法区间。与前端输入框的 min/max 一致；越界的值在保存时夹回来，
/// 而不是拒绝——旧版本落盘的 `0` 或缺字段都该能用。
pub const MIN_FONT_SIZE: u16 = 9;
pub const MAX_FONT_SIZE: u16 = 28;
pub const DEFAULT_FONT_SIZE: u16 = 13;

impl Default for SessionSettings {
    fn default() -> Self {
        Self {
            cr_as_newline: false,
            console_timestamps: false,
            file_timestamps: false,
            timestamp_format: "yyyy-MM-dd HH:mm:ss.SSS".into(),
            log_directory: None,
            log_filename: "%Y%M%D-%h%m%s.log".into(),
            logging: false,
            new_log_on_toggle: false,
            font_size: DEFAULT_FONT_SIZE,
        }
    }
}

impl SessionMeta {
    pub fn terminal(
        id: impl Into<String>,
        title: impl Into<String>,
        shell: impl Into<String>,
        owner: impl Into<String>,
    ) -> Self {
        SessionMeta {
            id: id.into(),
            title: title.into(),
            transport: TransportKind::Terminal,
            cwd: None,
            shell: Some(shell.into()),
            serial: None,
            settings: SessionSettings::default(),
            hot: false,
            owner: owner.into(),
        }
    }

    pub fn serial(
        id: impl Into<String>,
        title: impl Into<String>,
        config: SerialConfig,
        owner: impl Into<String>,
    ) -> Self {
        SessionMeta {
            id: id.into(),
            title: title.into(),
            transport: TransportKind::Serial,
            cwd: None,
            shell: None,
            serial: Some(config),
            settings: SessionSettings::default(),
            hot: false,
            owner: owner.into(),
        }
    }
}

/// 一个命名的会话容器：拥有若干会话，把它们铺在自己的分格树里，可以带一个根目录。
///
/// `layout` 为 `None` 表示空壳项目；`frozen` 只由 [`Workspace::set_project_frozen`]
/// 与几个明确的操作改写，主流程不直接动这个字段。
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: Option<String>,
    pub layout: Option<Layout>,
    pub frozen: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub sessions: Vec<SessionMeta>,
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceError {
    DuplicateSession(String),
    DuplicateProject(String),
    UnknownSession(String),
    UnknownProject(String),
    SessionAlreadyPlaced(String),
    /// 会话不在该项目里：不是这个项目的会话，或项目里根本没有这一格
    SessionNotInProject(String),
    /// 目标格不存在：项目已有布局却没给 target，或给的 id 不在布局里
    TargetNotPlaced(String),
    /// 项目已有布局时落点必须给 target
    MissingTarget(String),
    /// `SessionMeta.owner` 与调用方要求写入的项目不一致
    OwnerMismatch { session: String, project: String },
    /// 空标题没有意义，也没有可回退的显示文本
    InvalidTitle,
    /// 项目 id 不能为空
    InvalidId,
    TooDeep,
    InvalidRatio,
    /// `set_split_ratio` 的路径没有落在任何一个切割节点上
    SplitNotFound,
    /// 跨项目交换不是布局操作：两个会话必须属于同一个项目
    SwapAcrossProjects,
    /// 空壳项目上没有可供切分/移动的布局
    ProjectEmpty(String),
    /// 从文件读回来的形状不合法：重复项目 id、悬空放置、不变量被破坏等
    Corrupt(String),
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            sessions: Vec::new(),
            projects: Vec::new(),
        }
    }

    pub fn session(&self, id: &str) -> Option<&SessionMeta> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn session_mut(&mut self, id: &str) -> Option<&mut SessionMeta> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    pub fn project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
    }

    /// 会话的归属项目。找不到会话返回 `None`。
    pub fn owner_of(&self, session: &str) -> Option<&str> {
        self.session(session).map(|s| s.owner.as_str())
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
        let next = normalize_name(title)?;
        let session = self
            .session_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownSession(id.to_string()))?;
        if session.title == next {
            return Ok(false);
        }
        session.title = next;
        Ok(true)
    }

    /// 新建项目。id 由调用方生成（与端口的 `Uuid::new_v4()` 同源），core-domain 不造 id。
    /// 名称规则与会话标题一致：去首尾空白、按字符截断 40、全空白拒绝。
    pub fn new_project(
        &mut self,
        id: impl Into<String>,
        name: &str,
    ) -> Result<(), WorkspaceError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(WorkspaceError::InvalidId);
        }
        if self.project(&id).is_some() {
            return Err(WorkspaceError::DuplicateProject(id));
        }
        let name = normalize_name(name)?;
        self.projects.push(Project {
            id,
            name,
            root: None,
            layout: None,
            frozen: false,
        });
        Ok(())
    }

    pub fn rename_project(&mut self, id: &str, name: &str) -> Result<bool, WorkspaceError> {
        let next = normalize_name(name)?;
        let project = self
            .project_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownProject(id.to_string()))?;
        if project.name == next {
            return Ok(false);
        }
        project.name = next;
        Ok(true)
    }

    /// 设置/清除项目根目录。空字符串等价于清除；路径本身原样保存（允许空格）。
    pub fn set_project_root(
        &mut self,
        id: &str,
        root: Option<&str>,
    ) -> Result<bool, WorkspaceError> {
        let next = root
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty());
        let project = self
            .project_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownProject(id.to_string()))?;
        if project.root == next {
            return Ok(false);
        }
        project.root = next;
        Ok(true)
    }

    /// 冻结标记的唯一写入口。返回是否真的变了。
    ///
    /// 这里只记一个布尔值：真正「写快照、结束进程、释放串口」的顺序在会话层，
    /// core-domain 不碰 IO。
    pub fn set_project_frozen(&mut self, id: &str, frozen: bool) -> Result<bool, WorkspaceError> {
        let project = self
            .project_mut(id)
            .ok_or_else(|| WorkspaceError::UnknownProject(id.to_string()))?;
        if project.frozen == frozen {
            return Ok(false);
        }
        project.frozen = frozen;
        Ok(true)
    }

    /// 新建一个项目会话：`owner` 与 layout 在同一次调用里写完。
    ///
    /// `target` 为 `None` 表示项目是空壳（layout 也是 `None`），填第一格；
    /// 项目已有 layout 时 `target` 必须存在，否则 [`WorkspaceError::MissingTarget`] /
    /// [`WorkspaceError::TargetNotPlaced`]。
    ///
    /// 成功落位会把项目的 `frozen` 置回 false：项目里出现了活会话，就不再是冻结态。
    pub fn place_new_session_in_project(
        &mut self,
        project: &str,
        meta: SessionMeta,
        target: Option<&str>,
        side: Side,
        ratio: f32,
    ) -> Result<(), WorkspaceError> {
        if self.project(project).is_none() {
            return Err(WorkspaceError::UnknownProject(project.to_string()));
        }
        if meta.owner != project {
            return Err(WorkspaceError::OwnerMismatch {
                session: meta.id.clone(),
                project: project.to_string(),
            });
        }
        if self.session(&meta.id).is_some() {
            return Err(WorkspaceError::DuplicateSession(meta.id.clone()));
        }

        let ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        let next = {
            let layout = self
                .project(project)
                .and_then(|project| project.layout.as_ref());
            match (layout, target) {
                (None, None) => Layout::leaf(&meta.id),
                (None, Some(target)) => {
                    return Err(WorkspaceError::TargetNotPlaced(target.to_string()))
                }
                (Some(_), None) => return Err(WorkspaceError::MissingTarget(project.to_string())),
                (Some(layout), Some(target)) => {
                    let split = split_leaf(layout, target, side, ratio, &meta.id)
                        .ok_or_else(|| WorkspaceError::TargetNotPlaced(target.to_string()))?;
                    if split.depth() > MAX_SPLIT_DEPTH {
                        return Err(WorkspaceError::TooDeep);
                    }
                    split
                }
            }
        };

        self.sessions.push(meta);
        self.write_project_layout(project, Some(next));
        // 项目里出现了活会话，冻结态自然结束
        if let Some(target) = self.project_mut(project) {
            target.frozen = false;
        }
        Ok(())
    }

    /// 在项目内按几何方向搬一格。返回是否真的改变了布局。
    ///
    /// **先摘源叶子，再在摘除后的树上做深度检查与插入**：按原树算会把
    /// 「从深层拖到浅层」误判成超限（源格自己也在深度里）。
    pub fn move_pane_in_project(
        &mut self,
        project: &str,
        session: &str,
        target: &str,
        side: Side,
        ratio: f32,
    ) -> Result<bool, WorkspaceError> {
        let Some(layout) = self
            .project(project)
            .and_then(|project| project.layout.as_ref())
        else {
            return if self.project(project).is_some() {
                Err(WorkspaceError::ProjectEmpty(project.to_string()))
            } else {
                Err(WorkspaceError::UnknownProject(project.to_string()))
            };
        };
        if !layout.contains(session) {
            return Err(WorkspaceError::SessionNotInProject(session.to_string()));
        }
        if !layout.contains(target) {
            return Err(WorkspaceError::TargetNotPlaced(target.to_string()));
        }
        // 拖到自己是无操作，不是错误：前端可以在 pointerup 时统一提交
        if session == target {
            return Ok(false);
        }
        if move_is_noop(layout, session, target, side) {
            return Ok(false);
        }

        let ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        let after = remove_leaf(layout.clone(), session)
            .ok_or_else(|| WorkspaceError::SessionNotInProject(session.to_string()))?;
        let moved = split_leaf(&after, target, side, ratio, session)
            .ok_or_else(|| WorkspaceError::TargetNotPlaced(target.to_string()))?;
        if moved.depth() > MAX_SPLIT_DEPTH {
            return Err(WorkspaceError::TooDeep);
        }
        self.write_project_layout(project, Some(moved));
        Ok(true)
    }

    /// 改某个切割节点的比例。`path` 是从根节点开始的 0/1 序列（`false` = first，
    /// `true` = second）；根切割本身就是空路径。
    pub fn set_split_ratio(
        &mut self,
        project: &str,
        path: &[bool],
        ratio: f32,
    ) -> Result<bool, WorkspaceError> {
        let ratio = ratio.clamp(MIN_RATIO, MAX_RATIO);
        let Some(layout) = self
            .project_mut(project)
            .ok_or_else(|| WorkspaceError::UnknownProject(project.to_string()))?
            .layout
            .as_mut()
        else {
            return Err(WorkspaceError::ProjectEmpty(project.to_string()));
        };
        set_ratio_at(layout, path, ratio).ok_or(WorkspaceError::SplitNotFound)
    }

    /// 交换两个分格里的会话（拖到已占用的分格中心时用交换而不是替换）。
    pub fn swap_in_project(
        &mut self,
        project: &str,
        a: &str,
        b: &str,
    ) -> Result<(), WorkspaceError> {
        if self.project(project).is_none() {
            return Err(WorkspaceError::UnknownProject(project.to_string()));
        }
        if self.session(a).is_none() {
            return Err(WorkspaceError::UnknownSession(a.to_string()));
        }
        if self.session(b).is_none() {
            return Err(WorkspaceError::UnknownSession(b.to_string()));
        }
        if a == b {
            return Ok(());
        }
        let owned_here = [a, b]
            .iter()
            .all(|id| self.owner_of(id) == Some(project));
        if !owned_here {
            return Err(WorkspaceError::SwapAcrossProjects);
        }
        let Some(layout) = self
            .project(project)
            .and_then(|project| project.layout.as_ref())
        else {
            return Err(WorkspaceError::ProjectEmpty(project.to_string()));
        };
        if !layout.contains(a) {
            return Err(WorkspaceError::SessionNotInProject(a.to_string()));
        }
        if !layout.contains(b) {
            return Err(WorkspaceError::SessionNotInProject(b.to_string()));
        }
        if let Some(layout) = self.project_mut(project).and_then(|p| p.layout.as_mut()) {
            swap_leaves(layout, a, b);
        }
        Ok(())
    }

    /// 把一个分格里的会话换成新的：布局里那一个叶子改 id，旧会话元数据删除。
    ///
    /// 供「替换当前格」使用。它不做幂等：第二次调用找不到 `old_id` 就报错，
    /// 免得把一次失败的替换误当成成功。
    pub fn replace_pane(
        &mut self,
        project: &str,
        old_id: &str,
        new_meta: SessionMeta,
    ) -> Result<(), WorkspaceError> {
        if self.project(project).is_none() {
            return Err(WorkspaceError::UnknownProject(project.to_string()));
        }
        if new_meta.owner != project {
            return Err(WorkspaceError::OwnerMismatch {
                session: new_meta.id.clone(),
                project: project.to_string(),
            });
        }
        if new_meta.id == old_id || self.session(&new_meta.id).is_some() {
            return Err(WorkspaceError::DuplicateSession(new_meta.id));
        }
        let Some(layout) = self
            .project(project)
            .and_then(|project| project.layout.as_ref())
        else {
            return Err(WorkspaceError::ProjectEmpty(project.to_string()));
        };
        let replaced = replace_leaf(layout.clone(), old_id, &new_meta.id)
            .ok_or_else(|| WorkspaceError::SessionNotInProject(old_id.to_string()))?;
        if self.session(old_id).is_none() {
            return Err(WorkspaceError::UnknownSession(old_id.to_string()));
        }

        self.sessions.retain(|session| session.id != old_id);
        self.sessions.push(new_meta);
        self.write_project_layout(project, Some(replaced));
        // 替换进来的是一条新会话，项目不再是冻结态
        if let Some(target) = self.project_mut(project) {
            target.frozen = false;
        }
        Ok(())
    }

    /// 移除一个分格：摘叶、折叠父切割、删除会话元数据。最后一格被移除时项目留下
    /// 空壳（`layout = None`），并把 `frozen` 复位。历史与快照的销毁在会话层。
    /// 冷会话（`hot == false`）同样可以移除。
    pub fn remove_pane(
        &mut self,
        project: &str,
        session: &str,
    ) -> Result<CloseOutcome, WorkspaceError> {
        let Some(layout) = self
            .project(project)
            .and_then(|project| project.layout.as_ref())
        else {
            return if self.project(project).is_some() {
                Err(WorkspaceError::ProjectEmpty(project.to_string()))
            } else {
                Err(WorkspaceError::UnknownProject(project.to_string()))
            };
        };
        if !layout.contains(session) {
            return Err(WorkspaceError::SessionNotInProject(session.to_string()));
        }
        let Some(index) = self
            .sessions
            .iter()
            .position(|meta| meta.id == session && meta.owner == project)
        else {
            return Err(WorkspaceError::SessionNotInProject(session.to_string()));
        };

        self.sessions.remove(index);
        let current = self
            .project_mut(project)
            .and_then(|project| project.layout.take());
        let next = current.and_then(|layout| remove_leaf(layout, session));
        let emptied = next.is_none();
        if let Some(project) = self.project_mut(project) {
            project.layout = next;
            if emptied {
                // 空壳不再是冻结态：下次往这里投放会话时不该还带着旧的冻结标记
                project.frozen = false;
            }
        }
        Ok(CloseOutcome {
            project_emptied: emptied,
        })
    }

    /// 删除整个项目，返回被清理的会话 id。运行时、历史与快照由调用方按 id 处理。
    pub fn delete_project(&mut self, id: &str) -> Result<Vec<String>, WorkspaceError> {
        let Some(index) = self.projects.iter().position(|project| project.id == id) else {
            return Err(WorkspaceError::UnknownProject(id.to_string()));
        };
        let removed = match &self.projects[index].layout {
            Some(layout) => layout.leaves().iter().map(|s| s.to_string()).collect(),
            None => Vec::new(),
        };
        self.sessions
            .retain(|session| session.owner != id);
        self.projects.remove(index);
        Ok(removed)
    }

    /// 结构校验：唯一性、两条归属不变量、悬空引用、重复放置、深度与比例。
    pub fn validate(&self) -> Result<(), WorkspaceError> {
        let mut seen_sessions = HashSet::new();
        for session in &self.sessions {
            if !seen_sessions.insert(session.id.as_str()) {
                return Err(WorkspaceError::DuplicateSession(session.id.clone()));
            }
        }

        let mut seen_projects = HashSet::new();
        // 会话 id → 它出现在哪个项目的 layout 里。全局一张表，跨项目重复放置也能查出来。
        let mut placed: HashMap<&str, &str> = HashMap::new();
        for project in &self.projects {
            if !seen_projects.insert(project.id.as_str()) {
                return Err(WorkspaceError::Corrupt(format!(
                    "duplicate project id {}",
                    project.id
                )));
            }
            if let Some(layout) = &project.layout {
                check_layout(layout, &self.sessions, &project.id, &mut placed)?;
            }
        }

        for session in &self.sessions {
            let owner = session.owner.as_str();
            if !seen_projects.contains(owner) {
                return Err(WorkspaceError::UnknownProject(owner.to_string()));
            }
            if placed.get(session.id.as_str()) != Some(&owner) {
                return Err(WorkspaceError::Corrupt(format!(
                    "session {} is owned by {} but not placed in its layout",
                    session.id, owner
                )));
            }
        }
        Ok(())
    }

    /// 只写布局，不碰 `frozen`：搬格子、改比例这类纯布局动作不该解除冻结，
    /// 否则用户在冻结项目里整理一下形状就会把它悄悄解冻。解除冻结只发生在
    /// 「有新会话落位/替换」和「项目变空壳」这些明确入口。
    fn write_project_layout(&mut self, project: &str, layout: Option<Layout>) {
        if let Some(target) = self.project_mut(project) {
            target.layout = layout;
        }
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseOutcome {
    /// 关掉的是不是项目的最后一格。为 true 时项目留下空壳，节点仍在。
    pub project_emptied: bool,
}

fn normalize_name(name: &str) -> Result<String, WorkspaceError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::InvalidTitle);
    }
    Ok(trimmed.chars().take(MAX_TITLE_CHARS).collect())
}

fn leaf_name(layout: &Layout) -> Option<&str> {
    match layout {
        Layout::Leaf { session } => Some(session),
        Layout::Split { .. } => None,
    }
}

/// 找到「同时包含 a 与 b、且两者是它的两个直接叶子子节点」的那个切割节点。
fn sibling_split<'a>(layout: &'a Layout, a: &str, b: &str) -> Option<&'a Layout> {
    match layout {
        Layout::Leaf { .. } => None,
        Layout::Split { first, second, .. } => {
            if let (Some(head), Some(tail)) = (leaf_name(first), leaf_name(second)) {
                if (head == a && tail == b) || (head == b && tail == a) {
                    return Some(layout);
                }
            }
            sibling_split(first, a, b).or_else(|| sibling_split(second, a, b))
        }
    }
}

/// 拖动结果与现状完全等价才返回 true：直接兄弟、轴向不变、相对顺序也不变。
///
/// 只比叶子顺序会误杀合法操作——`Split(H, A, B)` 里把 A 拖到 B 的 Top，
/// 叶子顺序仍是 `[A, B]`，但轴向从横变竖，是一次真实的改变。
fn move_is_noop(layout: &Layout, session: &str, target: &str, side: Side) -> bool {
    let Some(Layout::Split {
        axis,
        first,
        second,
        ..
    }) = sibling_split(layout, session, target)
    else {
        return false;
    };
    if side.axis() != *axis {
        return false;
    }
    // 与 split_leaf 的结果一致：左/上插入时新格（源格）是第一个子节点
    let (want_first, want_second) = if side.new_first() {
        (session, target)
    } else {
        (target, session)
    };
    leaf_name(first) == Some(want_first) && leaf_name(second) == Some(want_second)
}

fn split_leaf(
    layout: &Layout,
    target: &str,
    side: Side,
    ratio: f32,
    new_session: &str,
) -> Option<Layout> {
    match layout {
        Layout::Leaf { session } if session == target => {
            let new_leaf = Layout::leaf(new_session);
            let (first, second) = if side.new_first() {
                (new_leaf, layout.clone())
            } else {
                (layout.clone(), new_leaf)
            };
            Some(Layout::Split {
                axis: side.axis(),
                ratio,
                first: Box::new(first),
                second: Box::new(second),
            })
        }
        Layout::Leaf { .. } => None,
        Layout::Split {
            axis,
            ratio: current,
            first,
            second,
        } => {
            if let Some(next) = split_leaf(first, target, side, ratio, new_session) {
                return Some(Layout::Split {
                    axis: *axis,
                    ratio: *current,
                    first: Box::new(next),
                    second: second.clone(),
                });
            }
            let next = split_leaf(second, target, side, ratio, new_session)?;
            Some(Layout::Split {
                axis: *axis,
                ratio: *current,
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
        } => match (remove_leaf(*first, session), remove_leaf(*second, session)) {
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

/// 把旧叶子换成新 id。没找到返回 `None`——不能把「这个叶子没变」当成命中，
/// 否则一次没替换成功的调用也会被当成成功。
fn replace_leaf(layout: Layout, old: &str, new: &str) -> Option<Layout> {
    match layout {
        Layout::Leaf { session } if session == old => Some(Layout::Leaf {
            session: new.to_string(),
        }),
        Layout::Leaf { .. } => None,
        Layout::Split {
            axis,
            ratio,
            first,
            second,
        } => {
            if first.contains(old) {
                let next = replace_leaf(*first, old, new)?;
                Some(Layout::Split {
                    axis,
                    ratio,
                    first: Box::new(next),
                    second,
                })
            } else {
                let next = replace_leaf(*second, old, new)?;
                Some(Layout::Split {
                    axis,
                    ratio,
                    first,
                    second: Box::new(next),
                })
            }
        }
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

fn set_ratio_at(layout: &mut Layout, path: &[bool], ratio: f32) -> Option<bool> {
    match layout {
        Layout::Leaf { .. } => None,
        Layout::Split {
            ratio: current,
            first,
            second,
            ..
        } => {
            if path.is_empty() {
                if (*current - ratio).abs() < f32::EPSILON {
                    return Some(false);
                }
                *current = ratio;
                return Some(true);
            }
            let next = if path[0] { second } else { first };
            set_ratio_at(next, &path[1..], ratio)
        }
    }
}

fn check_layout<'a>(
    layout: &'a Layout,
    sessions: &'a [SessionMeta],
    project: &'a str,
    placed: &mut HashMap<&'a str, &'a str>,
) -> Result<(), WorkspaceError> {
    if layout.depth() > MAX_SPLIT_DEPTH {
        return Err(WorkspaceError::TooDeep);
    }
    match layout {
        Layout::Leaf { session } => {
            if !sessions.iter().any(|meta| &meta.id == session) {
                return Err(WorkspaceError::UnknownSession(session.clone()));
            }
            if placed.insert(session.as_str(), project).is_some() {
                return Err(WorkspaceError::SessionAlreadyPlaced(session.clone()));
            }
            Ok(())
        }
        Layout::Split {
            ratio, first, second, ..
        } => {
            // 与 write 侧的夹取区间一致：0.1–0.9。NaN 也在这里被挡掉
            if !(*ratio >= MIN_RATIO && *ratio <= MAX_RATIO) {
                return Err(WorkspaceError::InvalidRatio);
            }
            check_layout(first, sessions, project, placed)?;
            check_layout(second, sessions, project, placed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(id: &str, project: &str) -> SessionMeta {
        SessionMeta::terminal(id, id, "pwsh.exe", project)
    }

    fn one_project() -> (Workspace, String) {
        let mut workspace = Workspace::new();
        workspace.new_project("p1", "PinShell").unwrap();
        (workspace, "p1".to_string())
    }

    fn place_first(workspace: &mut Workspace, project: &str, id: &str) {
        workspace
            .place_new_session_in_project(project, owned(id, project), None, Side::Right, 0.5)
            .unwrap();
    }

    fn two_panes() -> (Workspace, String) {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        workspace
            .place_new_session_in_project(
                &project,
                owned("b", &project),
                Some("a"),
                Side::Right,
                0.5,
            )
            .unwrap();
        (workspace, project)
    }

    fn layout_of<'a>(workspace: &'a Workspace, project: &str) -> &'a Layout {
        workspace
            .project(project)
            .and_then(|project| project.layout.as_ref())
            .expect("project layout")
    }

    #[test]
    fn new_project_normalizes_the_name_and_rejects_bad_input() {
        let mut workspace = Workspace::new();
        workspace.new_project("p1", "  部署环境  ").unwrap();
        assert_eq!(workspace.project("p1").unwrap().name, "部署环境");
        // 按字符截断：中文与 emoji 都不会被切一半
        let long = "配".repeat(30) + &"🚀".repeat(20);
        workspace.new_project("p2", &long).unwrap();
        let name = &workspace.project("p2").unwrap().name;
        assert_eq!(name.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(name, &("配".repeat(30) + &"🚀".repeat(10)));

        assert_eq!(
            workspace.new_project("p3", "   "),
            Err(WorkspaceError::InvalidTitle)
        );
        assert_eq!(
            workspace.new_project("p1", "again"),
            Err(WorkspaceError::DuplicateProject("p1".into()))
        );
        assert_eq!(workspace.new_project("  ", "x"), Err(WorkspaceError::InvalidId));
    }

    #[test]
    fn rename_project_reports_only_real_changes() {
        let (mut workspace, project) = one_project();
        assert_eq!(workspace.rename_project(&project, "  新名字 "), Ok(true));
        assert_eq!(workspace.project(&project).unwrap().name, "新名字");
        assert_eq!(workspace.rename_project(&project, "新名字"), Ok(false));
        assert_eq!(
            workspace.rename_project(&project, "   "),
            Err(WorkspaceError::InvalidTitle)
        );
        assert_eq!(
            workspace.rename_project("ghost", "x"),
            Err(WorkspaceError::UnknownProject("ghost".into()))
        );
    }

    #[test]
    fn project_root_set_and_clear() {
        let (mut workspace, project) = one_project();
        assert_eq!(workspace.set_project_root(&project, Some("F:/PinShell")), Ok(true));
        assert_eq!(
            workspace.project(&project).unwrap().root.as_deref(),
            Some("F:/PinShell")
        );
        assert_eq!(workspace.set_project_root(&project, Some("F:/PinShell")), Ok(false));
        // 空串等价于清除；路径里的空格原样保留
        assert_eq!(workspace.set_project_root(&project, Some("   ")), Ok(true));
        assert_eq!(workspace.project(&project).unwrap().root, None);
        assert_eq!(
            workspace.set_project_root(&project, Some("C:/Program Files/App")),
            Ok(true)
        );
        assert_eq!(
            workspace.project(&project).unwrap().root.as_deref(),
            Some("C:/Program Files/App")
        );
    }

    #[test]
    fn placing_into_an_empty_project_fills_the_first_pane() {
        let (mut workspace, project) = one_project();
        workspace
            .place_new_session_in_project(
                &project,
                owned("a", &project),
                None,
                Side::Right,
                0.5,
            )
            .unwrap();
        assert_eq!(layout_of(&workspace, &project), &Layout::leaf("a"));
        assert_eq!(workspace.owner_of("a"), Some("p1"));
        assert!(workspace.project(&project).unwrap().frozen == false);
        workspace.validate().unwrap();

        // 已有布局时必须给 target
        assert_eq!(
            workspace.place_new_session_in_project(
                &project,
                owned("b", &project),
                None,
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::MissingTarget("p1".into()))
        );
        // 空壳时 target 不能有值
        let (mut empty, empty_project) = one_project();
        assert_eq!(
            empty.place_new_session_in_project(
                &empty_project,
                owned("b", &empty_project),
                Some("ghost"),
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::TargetNotPlaced("ghost".into()))
        );
    }

    #[test]
    fn placing_rejects_owner_mismatch_unknown_project_and_duplicate_ids() {
        let (mut workspace, project) = one_project();
        workspace.new_project("p2", "Other").unwrap();
        assert_eq!(
            workspace.place_new_session_in_project(
                &project,
                owned("x", "p2"),
                None,
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::OwnerMismatch {
                session: "x".into(),
                project: "p1".into()
            })
        );
        assert_eq!(
            workspace.place_new_session_in_project(
                "ghost",
                owned("x", "ghost"),
                None,
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::UnknownProject("ghost".into()))
        );

        place_first(&mut workspace, &project, "a");
        assert_eq!(
            workspace.place_new_session_in_project(
                &project,
                owned("a", &project),
                Some("a"),
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::DuplicateSession("a".into()))
        );
    }

    #[test]
    fn side_decides_order_and_the_axis() {
        for (side, axis, leaves) in [
            (Side::Right, Axis::Horizontal, vec!["a", "b"]),
            (Side::Left, Axis::Horizontal, vec!["b", "a"]),
            (Side::Bottom, Axis::Vertical, vec!["a", "b"]),
            (Side::Top, Axis::Vertical, vec!["b", "a"]),
        ] {
            let (mut workspace, project) = one_project();
            place_first(&mut workspace, &project, "a");
            workspace
                .place_new_session_in_project(
                    &project,
                    owned("b", &project),
                    Some("a"),
                    side,
                    0.3,
                )
                .unwrap();
            let layout = layout_of(&workspace, &project);
            match layout {
                Layout::Split {
                    axis: actual,
                    ratio,
                    ..
                } => {
                    assert_eq!(*actual, axis, "side={side:?}");
                    // 比例永远描述第一个子节点；左/上插入时新格拿 0.3
                    assert!((*ratio - 0.3).abs() < f32::EPSILON);
                }
                other => panic!("expected a split, got {other:?}"),
            }
            assert_eq!(layout.leaves(), leaves, "side={side:?}");
            workspace.validate().unwrap();
        }
    }

    #[test]
    fn placing_clamps_the_ratio_instead_of_rejecting_it() {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        workspace
            .place_new_session_in_project(
                &project,
                owned("b", &project),
                Some("a"),
                Side::Right,
                5.0,
            )
            .unwrap();
        match layout_of(&workspace, &project) {
            Layout::Split { ratio, .. } => assert!((*ratio - MAX_RATIO).abs() < f32::EPSILON),
            other => panic!("expected a split, got {other:?}"),
        }
        workspace.validate().unwrap();
    }

    #[test]
    fn placing_refuses_a_fourth_level_and_leaves_everything_untouched() {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        for (target, id) in [("a", "b"), ("b", "c"), ("c", "d")] {
            workspace
                .place_new_session_in_project(
                    &project,
                    owned(id, &project),
                    Some(target),
                    Side::Right,
                    0.5,
                )
                .unwrap();
        }
        let before = layout_of(&workspace, &project).clone();
        assert_eq!(
            workspace.place_new_session_in_project(
                &project,
                owned("e", &project),
                Some("d"),
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::TooDeep)
        );
        assert_eq!(layout_of(&workspace, &project), &before);
        assert!(workspace.session("e").is_none());
    }

    #[test]
    fn moving_onto_a_sibling_only_skips_the_true_noop() {
        // Split(H, a, b)：a 是 first、b 是 second
        let left = {
            let (mut workspace, project) = two_panes();
            let changed =
                workspace.move_pane_in_project(&project, "a", "b", Side::Left, 0.5);
            (workspace, project, changed)
        };
        assert_eq!(left.2, Ok(false));
        assert_eq!(layout_of(&left.0, &left.1).leaves(), vec!["a", "b"]);

        let right = {
            let (mut workspace, project) = two_panes();
            let changed =
                workspace.move_pane_in_project(&project, "a", "b", Side::Right, 0.5);
            (workspace, project, changed)
        };
        assert_eq!(right.2, Ok(true));
        assert_eq!(layout_of(&right.0, &right.1).leaves(), vec!["b", "a"]);

        for side in [Side::Top, Side::Bottom] {
            let (mut workspace, project) = two_panes();
            assert_eq!(
                workspace.move_pane_in_project(&project, "a", "b", side, 0.5),
                Ok(true),
                "side={side:?} 换轴应当生效"
            );
            assert_eq!(layout_of(&workspace, &project).depth(), 1);
            workspace.validate().unwrap();
        }
    }

    #[test]
    fn moving_onto_itself_is_a_noop_not_an_error() {
        let (mut workspace, project) = two_panes();
        assert_eq!(
            workspace.move_pane_in_project(&project, "a", "a", Side::Right, 0.5),
            Ok(false)
        );
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["a", "b"]);
    }

    #[test]
    fn moving_checks_project_membership_before_touching_the_tree() {
        let (mut workspace, project) = two_panes();
        workspace.new_project("p2", "Other").unwrap();
        workspace
            .place_new_session_in_project("p2", owned("x", "p2"), None, Side::Right, 0.5)
            .unwrap();

        assert_eq!(
            workspace.move_pane_in_project(&project, "x", "a", Side::Right, 0.5),
            Err(WorkspaceError::SessionNotInProject("x".into()))
        );
        assert_eq!(
            workspace.move_pane_in_project(&project, "a", "x", Side::Right, 0.5),
            Err(WorkspaceError::TargetNotPlaced("x".into()))
        );
        // 兄弟与目标的原始顺序都没动
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["a", "b"]);
    }

    #[test]
    fn moving_from_a_deep_branch_is_measured_after_removal() {
        // Split1(Split2(Split3(A,B),C),D)：A、B 在第 3 层，C 在第 2 层。
        // 这种形状没法用「只在叶子上切分」的操作拼出来，测试直接构造。
        let (mut workspace, project) = one_project();
        for id in ["a", "b", "c", "d"] {
            workspace.sessions.push(owned(id, &project));
        }
        workspace.projects[0].layout = Some(Layout::Split {
            axis: Axis::Horizontal,
            ratio: 0.5,
            first: Box::new(Layout::Split {
                axis: Axis::Horizontal,
                ratio: 0.5,
                first: Box::new(Layout::Split {
                    axis: Axis::Horizontal,
                    ratio: 0.5,
                    first: Box::new(Layout::leaf("a")),
                    second: Box::new(Layout::leaf("b")),
                }),
                second: Box::new(Layout::leaf("c")),
            }),
            second: Box::new(Layout::leaf("d")),
        });
        workspace.validate().unwrap();
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["a", "b", "c", "d"]);
        assert_eq!(layout_of(&workspace, &project).depth(), 3);

        // 按原树算：B 在第 3 层，再切一格就是第 4 层，会被误判超限。
        // 先摘 C 之后 Split2 折叠、B 上浮到第 2 层，结果正好 3 层。
        assert_eq!(
            workspace.move_pane_in_project(&project, "c", "b", Side::Right, 0.5),
            Ok(true)
        );
        let layout = layout_of(&workspace, &project);
        assert_eq!(layout.depth(), 3);
        assert_eq!(layout.leaves(), vec!["a", "b", "c", "d"]);
        workspace.validate().unwrap();
    }

    #[test]
    fn set_split_ratio_clamps_and_reports_changes() {
        let (mut workspace, project) = two_panes();
        assert_eq!(workspace.set_split_ratio(&project, &[], 0.7), Ok(true));
        assert_eq!(workspace.set_split_ratio(&project, &[], 0.7), Ok(false));
        assert_eq!(workspace.set_split_ratio(&project, &[], 5.0), Ok(true));
        match layout_of(&workspace, &project) {
            Layout::Split { ratio, .. } => assert!((*ratio - MAX_RATIO).abs() < f32::EPSILON),
            other => panic!("expected a split, got {other:?}"),
        }
        // path 指不到切割节点
        assert_eq!(
            workspace.set_split_ratio(&project, &[true], 0.5),
            Err(WorkspaceError::SplitNotFound)
        );
    }

    #[test]
    fn nested_split_ratio_path_addresses_the_inner_node() {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        workspace
            .place_new_session_in_project(&project, owned("b", &project), Some("a"), Side::Right, 0.5)
            .unwrap();
        workspace
            .place_new_session_in_project(&project, owned("c", &project), Some("b"), Side::Bottom, 0.5)
            .unwrap();
        // 根是 Split(a, Split(b, c))：path = [true] 指向内层
        assert_eq!(workspace.set_split_ratio(&project, &[true], 0.2), Ok(true));
        match layout_of(&workspace, &project) {
            Layout::Split { ratio, second, .. } => {
                assert!((*ratio - 0.5).abs() < f32::EPSILON);
                match second.as_ref() {
                    Layout::Split { ratio, .. } => assert!((*ratio - 0.2).abs() < f32::EPSILON),
                    other => panic!("expected inner split, got {other:?}"),
                }
            }
            other => panic!("expected a split, got {other:?}"),
        }
    }

    #[test]
    fn swap_only_works_inside_one_project() {
        let (mut workspace, project) = two_panes();
        workspace.swap_in_project(&project, "a", "b").unwrap();
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["b", "a"]);
        workspace.swap_in_project(&project, "a", "a").unwrap();

        workspace.new_project("p2", "Other").unwrap();
        workspace
            .place_new_session_in_project("p2", owned("x", "p2"), None, Side::Right, 0.5)
            .unwrap();
        assert_eq!(
            workspace.swap_in_project(&project, "a", "x"),
            Err(WorkspaceError::SwapAcrossProjects)
        );
        assert_eq!(
            workspace.swap_in_project(&project, "a", "ghost"),
            Err(WorkspaceError::UnknownSession("ghost".into()))
        );
    }

    #[test]
    fn replace_pane_swaps_the_leaf_and_the_metadata() {
        let (mut workspace, project) = two_panes();
        workspace
            .replace_pane(&project, "a", owned("a2", &project))
            .unwrap();
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["a2", "b"]);
        assert!(workspace.session("a").is_none());
        assert_eq!(workspace.session("a2").unwrap().owner, "p1");
        workspace.validate().unwrap();

        // 不做幂等：第二次找不到旧 id 就报错
        assert_eq!(
            workspace.replace_pane(&project, "a", owned("a3", &project)),
            Err(WorkspaceError::SessionNotInProject("a".into()))
        );
        // owner 不符
        assert_eq!(
            workspace.replace_pane(&project, "b", owned("a4", "p2")),
            Err(WorkspaceError::OwnerMismatch {
                session: "a4".into(),
                project: "p1".into()
            })
        );
    }

    #[test]
    fn removing_a_pane_collapses_its_parent_and_the_last_one_leaves_a_shell() {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        workspace
            .place_new_session_in_project(&project, owned("b", &project), Some("a"), Side::Right, 0.5)
            .unwrap();
        workspace
            .place_new_session_in_project(&project, owned("c", &project), Some("b"), Side::Right, 0.5)
            .unwrap();

        let outcome = workspace.remove_pane(&project, "b").unwrap();
        assert!(!outcome.project_emptied);
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["a", "c"]);
        assert_eq!(layout_of(&workspace, &project).depth(), 1);
        assert!(workspace.session("b").is_none());
        workspace.validate().unwrap();

        // 最后一个格子移除后项目变成空壳，节点还在
        workspace.remove_pane(&project, "a").unwrap();
        let outcome = workspace.remove_pane(&project, "c").unwrap();
        assert!(outcome.project_emptied);
        assert!(workspace.project(&project).is_some());
        assert_eq!(workspace.project(&project).unwrap().layout, None);
        assert_eq!(workspace.project(&project).unwrap().frozen, false);
        workspace.validate().unwrap();
    }

    #[test]
    fn a_frozen_pane_can_still_be_removed() {
        let (mut workspace, project) = two_panes();
        workspace.set_hot("a", false).unwrap();
        workspace.set_project_frozen(&project, true).unwrap();
        workspace.remove_pane(&project, "a").unwrap();
        assert!(workspace.session("a").is_none());
        assert_eq!(layout_of(&workspace, &project).leaves(), vec!["b"]);
    }

    #[test]
    fn delete_project_returns_the_sessions_it_removed() {
        let (mut workspace, project) = two_panes();
        let mut removed = workspace.delete_project(&project).unwrap();
        removed.sort();
        assert_eq!(removed, vec!["a".to_string(), "b".to_string()]);
        assert!(workspace.project(&project).is_none());
        assert!(workspace.session("a").is_none());
        assert_eq!(
            workspace.delete_project(&project),
            Err(WorkspaceError::UnknownProject("p1".into()))
        );
        assert!(workspace.sessions.is_empty());
    }

    #[test]
    fn frozen_is_reset_only_by_arrivals_not_by_layout_edits() {
        let (mut workspace, project) = two_panes();
        assert_eq!(workspace.set_project_frozen(&project, true), Ok(true));
        assert_eq!(workspace.set_project_frozen(&project, true), Ok(false));

        // 搬格子、改比例都不解除冻结：整理布局不等于开始工作
        assert_eq!(
            workspace.move_pane_in_project(&project, "b", "a", Side::Bottom, 0.5),
            Ok(true)
        );
        assert_eq!(workspace.set_split_ratio(&project, &[], 0.4), Ok(true));
        assert_eq!(workspace.project(&project).unwrap().frozen, true);

        // 新会话落位 → 复位
        workspace
            .place_new_session_in_project(&project, owned("c", &project), Some("a"), Side::Right, 0.5)
            .unwrap();
        assert_eq!(workspace.project(&project).unwrap().frozen, false);

        // 替换进来一条新会话 → 复位
        workspace.set_project_frozen(&project, true).unwrap();
        workspace
            .replace_pane(&project, "c", owned("c2", &project))
            .unwrap();
        assert_eq!(workspace.project(&project).unwrap().frozen, false);
    }

    #[test]
    fn validate_rejects_duplicate_ids() {
        let mut workspace = Workspace::new();
        workspace
            .sessions
            .push(SessionMeta::terminal("a", "a", "pwsh.exe", "p1"));
        workspace
            .sessions
            .push(SessionMeta::terminal("a", "a", "pwsh.exe", "p1"));
        assert_eq!(
            workspace.validate(),
            Err(WorkspaceError::DuplicateSession("a".into()))
        );

        let (mut duplicated, project) = one_project();
        let clone = duplicated.project(&project).unwrap().clone();
        duplicated.projects.push(clone);
        assert!(matches!(
            duplicated.validate(),
            Err(WorkspaceError::Corrupt(message)) if message.contains("duplicate project")
        ));
    }

    #[test]
    fn validate_rejects_dangling_placements_and_broken_ownership() {
        let (mut workspace, project) = two_panes();
        workspace.projects[0].layout = Some(Layout::Split {
            axis: Axis::Horizontal,
            ratio: 0.5,
            first: Box::new(Layout::leaf("a")),
            second: Box::new(Layout::leaf("ghost")),
        });
        assert_eq!(
            workspace.validate(),
            Err(WorkspaceError::UnknownSession("ghost".into()))
        );

        // owner 指向不存在的项目
        let (mut dangling, _project) = two_panes();
        dangling.sessions.push(owned("x", "ghost"));
        assert_eq!(
            dangling.validate(),
            Err(WorkspaceError::UnknownProject("ghost".into()))
        );

        // 有 owner 却不在布局里
        let (mut unplaced, _project) = two_panes();
        unplaced.sessions.push(owned("x", &project));
        assert!(matches!(
            unplaced.validate(),
            Err(WorkspaceError::Corrupt(message)) if message.contains("not placed")
        ));
    }

    #[test]
    fn validate_rejects_twice_placed_and_bad_shapes() {
        let (mut twice, _project) = one_project();
        twice.sessions.push(owned("a", "p1"));
        twice.projects[0].layout = Some(Layout::Split {
            axis: Axis::Horizontal,
            ratio: 0.5,
            first: Box::new(Layout::leaf("a")),
            second: Box::new(Layout::leaf("a")),
        });
        assert_eq!(
            twice.validate(),
            Err(WorkspaceError::SessionAlreadyPlaced("a".into()))
        );

        let (mut bad_ratio, _project) = one_project();
        bad_ratio.sessions.push(owned("a", "p1"));
        bad_ratio.sessions.push(owned("b", "p1"));
        bad_ratio.projects[0].layout = Some(Layout::Split {
            axis: Axis::Horizontal,
            ratio: 1.5,
            first: Box::new(Layout::leaf("a")),
            second: Box::new(Layout::leaf("b")),
        });
        assert_eq!(bad_ratio.validate(), Err(WorkspaceError::InvalidRatio));

        // 低于下限的比例同样不合法（写入侧会夹取，读回侧要能挡住手改过的文件）
        let (mut narrow_ratio, _project) = one_project();
        narrow_ratio.sessions.push(owned("a", "p1"));
        narrow_ratio.sessions.push(owned("b", "p1"));
        narrow_ratio.projects[0].layout = Some(Layout::Split {
            axis: Axis::Horizontal,
            ratio: 0.05,
            first: Box::new(Layout::leaf("a")),
            second: Box::new(Layout::leaf("b")),
        });
        assert_eq!(narrow_ratio.validate(), Err(WorkspaceError::InvalidRatio));

        let (mut too_deep, _project) = one_project();
        let mut ids = vec!["a", "b", "c", "d", "e"];
        for id in &ids {
            too_deep.sessions.push(owned(id, "p1"));
        }
        let mut nested = Layout::leaf(ids.pop().unwrap());
        for id in ids.iter().rev() {
            nested = Layout::Split {
                axis: Axis::Vertical,
                ratio: 0.5,
                first: Box::new(Layout::leaf(*id)),
                second: Box::new(nested),
            };
        }
        too_deep.projects[0].layout = Some(nested);
        assert_eq!(too_deep.validate(), Err(WorkspaceError::TooDeep));
    }

    #[test]
    fn set_cwd_reports_only_real_changes() {
        let (mut workspace, _project) = two_panes();
        assert_eq!(workspace.set_cwd("a", "C:/Users/me"), Ok(true));
        assert_eq!(workspace.session("a").unwrap().cwd.as_deref(), Some("C:/Users/me"));
        // 同一个目录反复上报（每次提示符都会来一条）不算变更，调用方据此跳过落盘
        assert_eq!(workspace.set_cwd("a", "C:/Users/me"), Ok(false));
        assert_eq!(workspace.set_cwd("a", "D:/work"), Ok(true));
        assert_eq!(
            workspace.set_cwd("missing", "C:/"),
            Err(WorkspaceError::UnknownSession("missing".into()))
        );
    }

    #[test]
    fn depth_of_lines_up_with_validation_at_the_limit() {
        // 链式切 3 层：a(0) → b(1) → c(2) → d(3)
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        for (target, id) in [("a", "b"), ("b", "c"), ("c", "d")] {
            workspace
                .place_new_session_in_project(
                    &project,
                    owned(id, &project),
                    Some(target),
                    Side::Right,
                    0.5,
                )
                .unwrap();
        }
        let layout = layout_of(&workspace, &project);
        assert_eq!(layout.depth(), MAX_SPLIT_DEPTH);
        // depth_of 必须与 validate 的口径一致：validate 允许 3 层，
        // depth_of 就得如实报 3；差 1 会让落点预检误拒或误放行。
        // 链式切分会把前一格继续压深，所以这里按实际形状断言：
        // S1(a, S2(b, S3(c, d))) → a=1、b=2、c=3、d=3。
        for (id, expected) in [("a", 1), ("b", 2), ("c", 3), ("d", 3)] {
            assert_eq!(layout.depth_of(id), Some(expected), "session={id}");
        }
        assert_eq!(
            layout_of(&workspace, &project)
                .leaves()
                .iter()
                .filter_map(|id| layout.depth_of(id))
                .max(),
            Some(MAX_SPLIT_DEPTH)
        );
        workspace.validate().unwrap();
        // 在第 3 层再切一格：validate 与写法都会拒绝，预检用的是同一个数
        assert_eq!(
            workspace.place_new_session_in_project(
                &project,
                owned("e", &project),
                Some("d"),
                Side::Right,
                0.5
            ),
            Err(WorkspaceError::TooDeep)
        );
    }

    #[test]
    fn rename_session_trims_truncates_and_rejects_blank() {
        let (mut workspace, project) = one_project();
        place_first(&mut workspace, &project, "a");
        assert_eq!(workspace.rename_session("a", "  部署窗口  "), Ok(true));
        assert_eq!(workspace.session("a").unwrap().title, "部署窗口");
        assert_eq!(workspace.rename_session("a", "部署窗口"), Ok(false));
        assert_eq!(
            workspace.rename_session("a", "   "),
            Err(WorkspaceError::InvalidTitle)
        );
        let long = "配".repeat(30) + &"🚀".repeat(20);
        assert_eq!(workspace.rename_session("a", &long), Ok(true));
        let title = workspace.session("a").unwrap().title.clone();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(
            workspace.rename_session("missing", "x"),
            Err(WorkspaceError::UnknownSession("missing".into()))
        );
    }
}
