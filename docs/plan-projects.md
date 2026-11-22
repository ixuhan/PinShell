# 项目功能实施计划

> 依据：`docs/adr/0008-project-is-the-only-container.md`（取代 ADR 0006 的并列关系）、GLOSSARY「项目」「归属」「项目栏」「分格」。
> 目标形态：左栏固定为项目栏；项目拥有自己的会话并铺在自己的分格树里（例：2×2，左上 pwsh、右上串口、左下 cmd、右下 Git Bash）；每条会话都属于一个项目。

## 阶段 0 — 数据模型（纯逻辑，用户不可见）

- `src-tauri/core-domain/src/workspace.rs`：
  - 删掉从未接线的 `Window`、`Rect`、`WindowNotFound`、`CrossWindowSwap`、`window_of`、`next_window_id`。
  - 新增 `Project { id, name, root: Option<String>, layout: Option<Layout>, frozen: bool }`。`layout: None` 是空壳项目唯一的表达；`frozen` 只有阶段 4 会写，阶段 0 先占位以免再改一次 JSON 形状。
  - 新增 `Side { Left, Right, Top, Bottom }`：新格插在目标格的哪一侧，`axis` 由它推出。只带 `Axis` 无法表达「拖到左边缘 / 上边缘」。
  - `Layout` 保持原样（二叉树、最深 3 层、比例 0.1–0.9）。`SessionMeta.owner: String` 必填；`Workspace { sessions, projects }`。没有「不属于任何项目」的会话。
- 新增不变量并写进 `validate()`：
  1. `owner` 指向的项目必须存在；
  2. 会话出现在该项目的 layout 里恰好一次；
  3. 不存在无主会话：读文件时 `owner` 缺失或为空的会话直接丢弃。
- 新操作（每个公开操作返回时都必须自身满足 `validate()`）：
  - `new_project(id, name)`：id 由 main.rs 用 `Uuid::new_v4()` 传入，core-domain 不生成 id；名称规则同会话标题（trim、按字符截断 40、全空白拒绝）。
  - `rename_project` / `set_project_root`：返回「是否真的变了」；空字符串等价于清除根目录。
  - `place_new_session_in_project(project, meta, target: Option<&str>, side: Side, ratio)`：一次写完 owner 与 layout。先校验 `meta.owner == project`（不符 `OwnerMismatch`）；`target` 为 `None` 时要求项目 layout 也是 `None` 并直接填第一格，否则 `TargetNotPlaced`。
  - `move_pane_in_project(project, session, target, side, ratio)`：把已有格子移到 `target` 的某一侧。**先把源叶子摘掉、再按摘除后的树做深度检查与插入**；按原树算会把「从深层拖到浅层」误判成超限。拒绝三种无效移动：拖到自身、拖到自己的子树里、拖到唯一兄弟（摘完没有兄弟了）。
  - `split_in_project`：内部步骤，要求 layout 已存在；空壳分支由 `place_new_session_in_project` 显式处理，不做隐式退化。
  - `swap_in_project`：两格必须同属该项目，跨项目返回 `SwapAcrossProjects`。
  - `set_split_ratio(project, path: &[bool], ratio)`：`path` 是从根开始的 0/1 序列，定位到某个 `Split` 节点；校验深度与比例夹取，返回是否真的变了。分隔条拖完必须调它，否则比例永远只在内存里，切项目或重启就弹回默认。
  - `remove_pane(project, session)`：摘叶、折叠父切割、删除会话元数据；最后一格被移除时 layout 置 `None`，返回 `{ project_emptied: bool }`。这是唯一的销毁路径（历史与快照在 main.rs 里一起删）。
  - `replace_pane(project, old_session, new_meta)`：把 layout 里那一个叶子从旧 id 换成新 id，同时删除旧会话元数据；失败时 layout 与 sessions 一个都不动。顺序问题见阶段 2。
  - `delete_project(id) -> Vec<String>`：删除项目并返回它拥有的全部 session id，交给 main.rs 结束运行时、删历史与快照。阶段 0 只实现纯逻辑，阶段 2 接线。
  - 没有 `add_session` / `close_session`：会话只能通过项目操作进入或离开工作区（`place_new_session_in_project` / `replace_pane` / `remove_pane` / `delete_project`）。
- `src-tauri/src/persistence.rs`：`workspace.json` 升 v4
  ```json
  { "version": 4,
    "sessions": [ { "id": "…", "owner": "p1", "title": "…", "transport": "terminal", "…": "…" } ],
    "projects": [ { "id": "p1", "name": "PinShell", "root": "F:/PinShell", "frozen": false,
                    "layout": { "kind": "split", "axis": "horizontal", "ratio": 0.5, "…": "…" } } ] }
  ```
  - 删掉 `windows[]` 与 `WindowFile`。
  - `SessionFile.owner` 带 `#[serde(default)]`（读旧文件时缺失为空串），转成模型前丢弃空 owner 的会话——不做「未分组」收容。
  - **`WorkspaceFile.projects` 必须写 `#[serde(default)]`**，`ProjectFile` 的 `layout` / `frozen` 同样。v2 文件没有 `projects` 字段，缺默认值会让整个反序列化失败、走 `Unreadable`，老用户的工作区直接读不出来。
  - 已核实：版本比较是 `version > WORKSPACE_VERSION`（不是 `!=`），结构体也没有 `deny_unknown_fields`，所以 v2 能被读入、`windows[]` 会被忽略。这两点要写进测试，别在重构时改掉。
- 验收：`core-domain` 单测覆盖两条不变量、`Side` 四个方向的插入顺序、`move_pane_in_project` 的深度重算与三种无效移动、`set_split_ratio` 的路径校验与夹取、`remove_pane` 折叠与空壳、`replace_pane` 原子性、`delete_project` 返回的 id 列表、名称规则。persistence 侧除 v4 往返外，必须有一条**真实 v2 夹具**读回测试（只有 `windows`、没有 `projects`，结果是无会话、无项目）。`cargo test -p core-domain` 全绿。

## 阶段 1 — 多终端渲染层（最大的一块）

现状是单例：`src/main.ts` 一个 `term`，`attach(id)` 靠 `term.reset()` + 整屏重放切会话，输入条、所有权、历史缓存、文件面板全绑在全局 `sessionId` 上。

- **终端池**：`Map<sessionId, TerminalView>`，视图持有 `{ id, term, fit, hostEl, outQueue, lastSeq }`。每个视图的 `hostEl` 是**持久的**：切分、合并、交换布局时只搬运这个节点，**绝不对同一个 `Terminal` 再调 `open()`**（二次 open 会重挂 DOM/canvas 并丢状态）。
- **渲染器**：同时最多 8 个 WebGL 上下文（浏览器上限约 16）。不可见视图不挂 `WebglAddon`，只解析不渲染；切换可见性时**先 dispose 失活的 addon，再给新可见的挂载**，否则瞬间叠加仍可能撞上限。超出预算的回退是 **DOM 渲染器**——xterm 6 没有 `@xterm/addon-canvas`，别按 canvas API 写。
- **隐藏与重建**：不可见项目**不接收实时输出**，切回时按 `pty_replay` 整屏重建——与今天切会话完全同构，不发明新的背压机制。可见项目内的非焦点格实时解析。
- **禁止隐藏格 fit**：`display:none` 下量到 0，会把错误的 cols/rows 发给 PTY。只有可见容器才 fit；切回可见时先 `fit`，再走现有 `resyncScreen`（贴回底部 + 整屏 `refresh`），滚动位置随之恢复。
- **焦点模型**：`focusSessionId` 取代全局 `sessionId`；输入条、`pty_ownership`、历史缓存、文件面板、HUD 都读焦点会话。切焦点不再重置终端，只改绑定并搬焦点。禁止搞一个会重新绑定的 `term` 别名；带 `id` 的函数一律 `views.get(id)`。
- **单例盘点**：除了 `term` 与 `sessionId`，这些模块级状态也要迁进视图或按 id 索引——`paused`、`own`、`serialKind`、`hexMode`、`lastSeq`/`pending`/`attaching`、`notice`、`cache`/`histIdx`/`overlayDraft`、`serialStatus`、时间戳锚点状态。属于窗口的（面板宽度、折叠）留在外面。
- **分格容器**：`#term-host` 下按 `Layout` 递归生成 flex 容器 + 分隔条；拖分隔条只改 CSS，松手后调 `set_split_ratio` 落盘，并对受影响的格子各 `fit` 一次、把尺寸下给 PTY。
- **成批 fit**：窗口或分格尺寸变化合并成一次 `ResizeObserver` 回调，避免 4 个格子各自触发 `pty_resize` 造成抖动。
- **调试入口**：dev 模式保留 `window.__pinshell_setLayout` 已经不需要——项目 CRUD 接线后直接右键建项目、建会话即可手工验收「2×2 同刷」。
- 验收：2×2 四格同时刷输出互不串行；焦点切换后输入条指向正确会话；拖比例后行列数正确且重启后保持；切走再切回滚动位置正确；关掉一格后其余格重排且不被压到 180px 以下。

## 阶段 2 — 项目栏与新建流程（ADR 0008）

- 左栏固定为**项目栏**：头部「全部收起 / 全部展开 / ＋新建项目」，项目行右侧「＋新建会话」与「⋯项目菜单」，底部常驻全局设置按钮。删除模式开关、独立会话列表与批量选择；展开状态存 `localStorage`（默认全展开）。项目行整行单击/双击都是展开/收起该项目（顺带选中）；「⋯」弹出的与右键菜单完全相同。
- **新建项目弹窗**：名称（必填、预填「新项目」并全选）与根目录（可留空、可清除）；与项目设置共用同一个表单，编辑模式多一行只读统计（终端几格、串口几格）。
- **新建会话弹窗**：传输方式（终端 / 串口）单选；名称（可留空，默认取 profile 名或端口名）；终端填 shell profile 与起始目录；串口填端口与 8N1 参数；落点（空项目隐藏，其余默认「向右切」，含「替换当前格」并写明它会删掉旧会话的历史与快照）。
- 主区跟随选中项目；冷启动回到上次选中的项目，没有项目就显示空状态（带「新建项目」按钮）。冷启动只拉起选中项目（终端热、串口冷）。
- 新建成功后的行为唯一：切到该项目、展开、预热终端格、焦点给新格、关闭弹窗。新建项目后不连锁弹会话弹窗，只在空项目主区给「新建会话」按钮。
- **两个动词必须分开**：「关格」只结束运行时，格子留在原处变冷、布局不重排、历史与快照都保留（前端直接调现有 `pty_freeze`，进程自然退出也走这条）；「移除这一格」才销毁会话，调 `remove_pane` 并沿用 `pty_close` 的历史与快照清理，二次确认。冷格子灰显，点它重新拉起。
- **冷格子占位**：终端与串口都要有（「打开项目时串口保持冷」意味着项目一打开就有冷格子）。视图池要能表达「这个 id 现在没有终端视图」，占位里显示标题、串口摘要与「连接 / 重新拉起」。这项能力在阶段 1 的视图池就要预留，阶段 2 接上界面。
- 后端：把 `session_tree` 与 `project_list` 合成一条 `workspace_snapshot`，一次返回 `{ sessions, projects }`，前端整份替换（与现有 `refreshTree` 同构）。分两条 IPC 会在两次返回之间出现「layout 引用了还没到的会话 id」。项目命令：`project_create/rename/set_root/delete`。**`project_delete` 在阶段 2 一步到位**：`delete_project` 返回 id 列表，main.rs 逐个结束运行时、`history.delete_session`、`remove_scrollback`。`project_freeze` 到阶段 4 实现后再注册。
- **落点参数**：`spawn_session` / `spawn_serial_session` 的 `project` 必填，另带 `target`、`placement`（`fill` / `left` / `right` / `top` / `bottom` / `replace`）与可选 `title`。次序是「锁内只读预检（项目存在、target 存在、深度、owner）→ spawn → 锁内复检并落位 → persist」。预检必须在 spawn 之前：串口开端口会翻 DTR/RTS 让嵌入式板子复位，不能靠失败回滚。落点失败要 kill 刚起的 shell、从 `state.sessions` 移除。`persist_workspace` 失败维持现有的「只记日志」语义，不要只给这一条路径做半套事务。
- **替换的顺序**：先 spawn 新进程（未进 workspace）→ 锁内 `replace_pane` 原子换叶子 → 最后关旧进程。不允许先关旧再开新：2×2 里换左上格会把左列整个塌掉，而且新进程起不来时旧会话已经没了。关旧时要幂等（它可能已经自然退出成冷会话）。
- **串口同口替换禁止**：串口格不能替换成它自己正占着的端口（新进程必然抢不到句柄）。提示用户改用格内「断开 / 连接」或改参数，不做「先释放再开」的接力（释放会翻 DTR/RTS 复位板子，中间还可能被别人抢走端口）。
- 项目会话的 cwd：请求为空时用项目 `root` 兜底；会话通过 OSC 7 上报过 CWD 之后以会话为准。
- 串口占用错误返回结构化数据 `{ port, project, session }`，由前端拼多语言文案，Rust 里不写中文句子。
- 验收：项目栏只有项目与会话两种行；项目格子占着 COM3 时，另一个项目开同一端口报出可读原因（含项目名）；重开应用回到上次选中的项目与展开状态；关掉一格后另外三格位置与尺寸不变，点那一格能原地恢复；删除项目后没有任何孤儿进程与孤儿历史行；新建项目/会话都必须经过弹窗，且会话弹窗的落点默认「向右切」。

## 阶段 3 — 拖拽组合

- 用指针事件实现，不用 HTML5 拖放（WebView2 下拖拽图像与 `preventDefault` 行为不一致）。拖动时在目标格叠加四个边缘热区与一个中心热区，离开热区给明确的高亮。
- 拖已有格子到另一格边缘 = `move_pane_in_project`（不是「移除再插入」，那会经过销毁路径）；拖到中心 = 交换。**不再支持拖 profile 新建会话**（新建只有弹窗一条路，ADR 0008）。
- **拖出项目不执行任何破坏性动作**：松手在侧栏或主区空白处一律回弹。移除一格走右键菜单加二次确认——「关格 = 冻结」已经保证了拖拽不需要承担销毁语义，手滑不该毁掉历史。
- 命中 3 层上限时给提示「已达最大嵌套，先合并两格」，不静默失败。
- 验收：2×2、1+2（左一整列、右上下两格）都能纯拖拽拼出来；拖到四个方向都能落位且顺序正确；从深层拖到浅层不被误判超限；交换不丢失任何会话；拖到项目外回弹且什么都不改变。

## 阶段 4 — 生命周期与打磨

- **冻结项目**：逐个格子走 `pty_freeze` 的收尾顺序（先 `reader_gen.fetch_add` 让旧读线程的收尾作废，再落快照，再关通道），然后写 `frozen = true` 并落盘。实现后再注册 `project_freeze`。
- **冻结项目的唤醒语义**：再次打开 `frozen = true` 的项目时**不自动拉起任何会话**，全部显示冷占位（可以看卷轴快照），点哪格拉哪格，另给一个「全部启动」按钮。从未冻结过的项目照旧「终端全起、串口全冷」。
- **删除项目**：连历史与快照一起销毁，二次确认写明。
- `Ctrl+Alt+方向键` 按几何最近邻搬焦点（现有 `Ctrl+Shift+P/L/K/Space`、`Ctrl+R` 全部已被占用）。落地前先实测是否被 Intel 显卡驱动的旋转屏幕快捷键占用，冲突就退到 `Ctrl+Alt+H/J/K/L`。命中的按键必须在捕获阶段 `preventDefault` 并阻止透传，否则焦点搬走的同时方向键序列会打进 vim。
- 多实例下复验既有行为：暂停/继续整屏重画、清窗口、时间戳锚点、卷轴快照接缝、Ghost Text 与 Ctrl+R 只作用于焦点会话；隐藏格不 fit、不挂 WebGL。
- i18n 文案（项目栏、新建项目/会话弹窗、全收起/全展开、拖拽提示），README 功能段补一条「项目」。

## 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| WebGL 上下文耗尽 | 每实例一个上下文，浏览器上限约 16 | 按可见性分配、切换时先 dispose 后挂载；超预算回退 **DOM 渲染器**（xterm 6 无 canvas addon） |
| xterm 重复 open | 布局变化时对同一个 Terminal 再 open 会丢状态 | 每个视图持有持久 `hostEl`，布局变化只搬节点 |
| 单例假设残留 | 暂停/继续、清屏、整屏重画、HEX、时间戳都写着模块级变量 | 阶段 1c 一次性迁到视图或按 id 索引，留单测覆盖「取错会话」 |
| 焦点与快捷键 | `Ctrl+Shift+P/L` 等读全局 `sessionId` | 统一改读 `focusSessionId`，对话框打开时照旧屏蔽 |
| 串口独占跨项目 | 两个项目抢同一个端口 | 结构化错误带占用方；同口替换直接禁止 |
| 拖拽与终端选区冲突 | xterm 里拖选文本 vs 拖分格 | 只有格子标题条可发起拖动，终端区域不拦截 |
| 隐藏项目耗 CPU | 后台项目刷屏日志会拖慢前台 | 隐藏项目不接收实时输出，切回按 `pty_replay` 重建 |
| 比例不落盘 | 拖完只改 CSS | 松手调 `set_split_ratio` 并 `persist_workspace` |
