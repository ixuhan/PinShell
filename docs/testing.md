# 测试方案 v1（2026-11-16 确认）

> 目标：给四类风险装上自动挡——**输入归属**、**会话生命周期**、**数据不丢/可还原**、**性能红线**；
> 同时保证测试**永远不打断前台开发**（不抢焦点、不抢构建锁、不碰真实数据）。
> 五条待决已拍板，见 §9「决策记录」；已落地的部分见 §10。分层理由记在 `docs/adr/0005-test-layering.md`。

## 0. 硬约束：测试不得打断前台工作

这六条是设计约束，任何用例违反就算不合格：

1. **不共用构建目录**。`tauri dev` 正在跑时，`target\debug\pinshell.exe` 被进程占用（现状：每次跑 dev 都会占用），任何同目录的 `cargo build/test` 要么等构建锁、要么链接失败。→ 轻量层必须能独立编译；重量层在 dev 未运行时才跑。
2. **不抢焦点**。会开真实窗口的用例只在「人离开时」或显式请求时跑，绝不进常跑路径。
3. **不占端口**。1420 归 dev server；需要前端服务时另起端口或直接用 `dist/` 静态产物。
4. **不碰真实数据**。测试一律把数据目录重定向到临时目录（`PINSHELL_DATA_DIR`），跑完即删；不写用户 profile、不写注册表 AutoRun（ADR 0003 已定「默认零侵入」，测试要验证它而不是破坏它）。`PINSHELL_DATA_DIR` 已随 M2 首个落盘模块实现（`src-tauri/src/persistence.rs`），优先级高于便携目录与 `%APPDATA%`。
5. **不留孤儿进程**。每个用例 teardown 断言子进程已退出；失败也要回收。
6. **不阻塞人**。结果落文件，不靠人看窗口；决策集中成一轮问题，不边跑边问。

## 1. 分层

| 层 | 范围 | 工具 | 典型耗时 | 何时跑 | 需要停 dev |
|---|---|---|---|---|---|
| **L0 纯逻辑** | 状态机、规则、解析、匹配、格式（无 IO、无 DOM、无进程） | Rust `cargo test` + `proptest`；前端 `vitest`（node 环境） | 秒级 | 每次改代码、push 前、随手 | 不需要（独立小目录） |
| **L1 集成** | 真 ConPTY 进程、字节往返、resize、关闭语义、脚本注入、原子落盘 | Rust 集成测试（`tests/`） | 10–60 s | 每天 / 后台 | 需要（同一套 Rust 依赖） |
| **L2 契约** | IPC 命令与事件形状、错误语义、缓存与库一致性 | Rust serde 测试 + TS 类型校验 | 秒级 | 随 L0 | 不需要 |
| **L3 端到端 / 性能** | 真窗口按键链路、启动时长、渲染吞吐、还原 | tauri-driver + msedgedriver；现有 bench harness | 分钟级 | 人离开时 / 里程碑验收 | 需要 |

**原则**：能下沉到 L0 的一律下沉。GUI 自动化是最后手段，不是默认手段。
**常跑集 = L0 + L2**：必须在用户正用着电脑的时候也能跑（定义见 GLOSSARY「常跑集」）。

## 2. 用例矩阵（首批）

### L0 纯逻辑

| 编号 | 用例 | 断言 |
|---|---|---|
| L0-01 | `Utf8Stream` 任意切分重组（proptest，含中文/emoji/孤立 0x80） | 拼接结果 == 整串解码，无多余 U+FFFD |
| L0-02 | 非法字节处理 | 坏字节替换为 U+FFFD 且不吞后续合法字符；尾部残缺留到下一块 |
| L0-03 | 输入所有权判定表（ADR 0003 全场景） | 备用屏 > 提示符就绪 > 运行中 > 未知；仅「就绪」归输入条 |
| L0-04 | 显式锁定 | 锁定后状态机说 Running 也不交还，直到再次切换 |
| L0-05 | 密码提示启发式 | Prompt 后首块无 `C` 且命中密码类提示 → 转 Running |
| L0-06 | 回车后 N 毫秒无 `A` | 判定为 Running（N 可配，测试注入时钟） |
| L0-07 | Ghost Text 前缀匹配 | 最近优先、大小写不敏感、去重、仅行尾单行非空白时出现；5000 条内 p99 < 1ms，同步计算不走 IPC |
| L0-09 | 时间戳锚点 | 跨天插一行、同日不插、按当前本地时区判断 |
| L0-10 | HEX 解析/格式化 | 空格、大写、奇数位、非法字符各有明确拒绝原因；往返一致 |
| L0-11 | 片段标题截断 | 按字符（非字节）截断，含 emoji 不裂 |
| L0-12 | 行结束符取值 | 终端固定 `\r`；串口按 CRLF / CR / LF |
| L0-13 | 会话状态机不变量 I1–I5 | 纯模型测试：冷会话无进程、关闭保留历史、退出不保活、同串口单热会话、清窗口不动历史 |
| L0-14 | 回放缓冲 | 序号从 1 递增、空块不占号、超上限按整块丢最旧、超大单块仍保留、清空后序号继续、清屏留下光标那一行（跨块拼接、连续清屏、超长行只留尾部且不切在半条转义序列上） |
| L0-15 | 工作区分格树 | 会话最多出现在一格、嵌套 ≤3 层、切开落在目标右侧/下方、关闭折叠父切割、最后一个分格关闭即窗口消失、跨窗口交换被拒、CWD 只在真变更时才算变更 |
| L0-16 | 卷轴快照组装 | 空快照不画分隔线、半行先补换行、重复重开各带一条分隔线、回放前丢掉备用屏与隐藏光标开关、末尾复位 SGR 并放出光标、分隔线不含 `133`/`7` 标记（不会被状态机误认成提示符） |
| L0-17 | 会话标题 | 去首尾空白、按字符截断到 40（中文/emoji 不切半）、全空白拒绝、未变更返回「没变」 |
| L0-18 | 历史库存储语义 | 去重挪到最新并累加次数、10k 封顶、会话隔离、清空只作用当前会话、删除节点销毁历史、时间戳 UTC 往返 |
| L0-19 | 清屏后的输出过滤 | 序号 ≤ 下限的块全部丢掉（哪怕清屏之后才到达）、其余按到达顺序拼、没有保留块时序号归零、下限为 0 时一块不丢 |
| L0-20 | 文件面板显示规则 | 目录优先且大小写不敏感排序、隐藏项过滤与计数、2000 条截断、路径归一化与父/子拼接、盘符根与 UNC 根、大小与时间格式、跟随/固定模式的目标路径 |

### L1 集成

| 编号 | 用例 | 断言 |
|---|---|---|
| L1-01 | spawn → write → read 往返（pwsh、cmd 各一次） | 输出含预期字符串，5 s 内到达 |
| L1-02 | resize | 子进程读到的新行列 == 请求值 |
| L1-03 | 关闭语义 | 子进程 PID 消失、读线程结束、无残留 |
| L1-04 | 高频输出 10 MB | 收到字节数一致、不 panic、内存不失控 |
| L1-05 | 多字节字符跨块切断 | 前端侧无伪 U+FFFD |
| L1-06 | 集成脚本注入 → OSC 133 A/C/D | 状态依次 Prompt → Running → Prompt |
| L1-07 | 零侵入断言 | 跑完后用户 `$PROFILE` 哈希不变、注册表 AutoRun 不变 |
| L1-08 | 原子写 | 写入中途杀进程后，`workspace.json` 与 `.bak` 至少一个可解析 |
| L1-09 | 未知 session id | 返回明确错误，不 panic、不崩进程 |
| L1-10 | 历史库损坏 | 主库改名为 `history.db.corrupt-<时间>` 并重建空库，启动不阻塞 |

### L2 契约

| 编号 | 用例 | 断言 |
|---|---|---|
| L2-01 | 事件形状 `pty:out{id,data}` / `pty:exit{id}` | Rust 序列化结果与 TS 类型一致（同源生成或显式校验） |
| L2-02 | 历史缓存契约 | `history_snapshot` 带 `upto_id`；`history:append` 的 `id` 单调；检测到缺口或重连整份重建；切会话丢弃缓存 |

### L3 端到端 / 性能（仅人离开时）

| 编号 | 用例 | 断言 |
|---|---|---|
| L3-01 | 冷启动到**可输入** | < 1.5 s（M1 后改用 OSC 133 `A`，不再用「首字节」） |
| L3-02 | 按键端到端 p99 | < 10 ms（含本地回显路径） |
| L3-03 | 1 MB 输出渲染（按帧聚合后） | ≥ 30 fps |
| L3-04 | vim 进出 | 进入时全透传、`:q` 后状态点回到「猜测/就绪」 |
| L3-05 | 关窗重开 | 工作区、会话树、CWD、卷轴分隔线还原一致 |
| L3-06 | 原生菜单 helper 崩溃（M4） | 主进程存活、菜单可重开 |

## 3. 与里程碑的对应

| 里程碑 | 首次可测的新东西 | 落在哪层 |
|---|---|---|
| M0（已完成） | UTF-8 分块、spawn/resize/close、渲染吞吐、IPC 往返 | L0-01/02、L1-01~05、L3-03 |
| M1（已完成） | 输入所有权状态机、集成脚本、可输入时刻 | L0-03~06、L1-06/07、L3-01/02/04 |
| M2（已完成） | 冷/热会话、回放缓冲、快照还原、原子写 | L0-13、L0-14、L0-15、L0-16、L0-17、L1-08、L3-05 |
| M3（已完成） | 历史库、Ghost Text、Ctrl+R | L0-07、L0-09、L0-18、L1-10、L2-02 |
| M3 打磨（已完成） | 暂停/继续、一键清窗口、卷轴行数上限、输入条按钮 | L0-19（+ 手工：暂停后继续还原、清屏不回填旧块） |
| M4（进行中） | 文件面板跟随 CWD（第一片已落地）、原生菜单 | L0-20、L1、L3-06 |
| M5 | 串口（假 Transport 优先，真串口靠虚拟串口对） | L0-12、L1 |
| M6 | 升级后恢复工作区 | L3 |

## 4. 夹具与隔离

- **假 Transport**：内存管道实现，串口先在它上面测，不需要装 com0com 之类的驱动（装驱动 = 打扰）。真串口验证单独列为手工项。
- **临时数据目录**：每个用例一个 `%TEMP%\pinshell-test-<guid>\`，经 `PINSHELL_DATA_DIR` 注入；用例结束递归删除。
- **环境探测而非硬失败**：缺 pwsh / 缺 WebView2 / 缺驱动 → 该用例 **skip 并记录原因**，绝不伪装成通过。
- **假终端必须会回答 DSR**：pwsh 启动时先发 `ESC[6n` 查光标位置，不回答就假死（见 `docs/research/04-osc-pwsh-probe.md`）。假终端要回 `ESC[1;1R`，否则 L1 集成测试看起来像卡住。
- **超时**：L0 每例 ≤ 2 s，L1 每例 ≤ 10 s，L3 每例 ≤ 60 s。超时即失败。
- **确定性**：时间相关用例注入假时钟；随机相关用例固定 seed；端口/临时目录都避开开发占用。

## 5. 性能红线与采集

| 红线 | 目标 | 采集点 | 用途 |
|---|---|---|---|
| 冷启动到可输入 | < 1.5 s | 模块求值 → OSC 133 `A`（M1 前用首字节占位） | 门禁 |
| 按键端到端 p99 | < 10 ms | 按键 down → 屏幕出现字符 | 门禁 |
| 1 MB 输出 | ≥ 30 fps | 按帧聚合写入后的耗时 | 门禁 |
| IPC 往返 | p50 < 2 ms、p99 < 5 ms | `bench_ping` × 300 | 记录趋势 |
| 常驻内存（单会话） | 待实测后定 | 进程工作集 | 记录趋势 |

- 门禁用 **release** 构建；debug 只记趋势，不判定。
- 同一台机连跑 5 次取中位数；单次偏离中位数 > 20% 视为噪声样本，重跑一次再判。
- 采集结果写成 JSON（`tests/report/latest.json`），不靠人读 HUD。性能数字仍由 `[bench]` stdout 行提供（`input-ready` 一行给「可输入」），脚本化采集待补。

## 6. 运行手册

| 命令 | 内容 | 实测耗时 | 前置条件 |
|---|---|---|---|
| `.\scripts\test-guard.ps1 -Layer l0` | 常跑集：core-domain 纯逻辑 + 前端纯逻辑（独立 target、子进程降优先级） | 1–2 s | 无 |
| `npm test` | 只跑前端纯逻辑（Ghost Text / 检索 / 跨天锚点 / 历史缓存 / 清屏过滤），vitest、node 环境 | ~1 s | 无 |
| `.\scripts\test-guard.ps1 -Layer it` | L1：真 pwsh/bash 标记链路 + 主 crate 单元测试（持久化） | ~2–6 s | dev 未运行；否则拒绝执行并返回 1 |
| `.\scripts\test-guard.ps1 -Layer all` | 两层；dev 在跑时只跑 L0 并打印原因 | ~1 s | 无 |
| `.\scripts\push.ps1` | 先跑 L0 门禁再推；`-SkipTests` 可跳过 | +0.5 s | 无 |

前端单测已接入：`src/history.ts`（Ghost Text / 检索 / 跨天锚点）、`src/historyCache.ts`（历史缓存契约）与 `src/outQueue.ts`（清屏后的输出过滤）都是值得测的纯函数模块，用 vitest（node 环境，不起窗口、不占 1420），已并入 L0 门禁。L3 性能采集仍然靠 `npm run app:dev` 手工采集；卷轴上限的吞吐与内存用 `scripts/bench-scrollback.mjs` 单独测（不依赖窗口）。

## 7. 汇报（已落地）

- 机器可读：`tests/report/latest.json`，每次门禁运行覆盖重写。含各层状态与耗时、用例逐一状态、`skip_reason`、`forced`（是否 `-Force` 强跑）。**没有逐例耗时**：libtest 的耗时报告仍是 nightly 特性，不为此换工具链。
- 人可读：`docs/test-report.md` 每次运行追加一行，只留最近 10 次；红的用例在最后一列点名（写作 `L0/模块::用例`）。
- 被跳过的层也算一次记录：`status = skipped` 带上原因（如 `tauri dev is running`），不会被误读成「通过」。
- 常跑失败时的动作：不打断人，报告里已有失败用例名与复现命令（`.\scripts\test-guard.ps1 -Layer l0`），等人有空处理。

## 8. 现在测不了的东西（诚实清单）

| 项 | 原因 | 什么时候能测 |
|---|---|---|
| 真 GUI 自动化 | 未装 `tauri-driver` + 匹配 WebView2 的 `msedgedriver`，且会抢焦点 | 等确认是否值得装 |
| 串口真设备 | 需要硬件或虚拟串口对驱动 | M5 |
| 原生菜单 helper 隔离 | 依赖 M4 的 helper 进程 | M4 |
| IME / 多显示器 / 字体回退 / 高 DPI | GUI 环境相关，自动化收益低 | 手工清单 |
| 多窗口（单主窗口之外的场景） | 产品未做 | 后续 |

## 9. 决策记录（2026-11-16 确认）

1. **验收口径**：优先级为 输入归属 > 数据不丢/可还原 > 性能红线 > 启动速度。性能只在 release 构建跑门禁，debug 只记趋势、不判定。
2. **L3 位置**：永不进常跑集。先用「无头 UI + 假 IPC」把能测的 UI 逻辑测掉；真窗口自动化推迟到 M4 之后，届时重新评估是否值得装驱动。
3. **可测性地基**：核心部分已完成（`core-domain` 独立 crate）。纯函数抽取随功能落地做，不预先空抽；`PINSHELL_DATA_DIR` 随 M2 首个落盘模块实现。
4. **构建隔离**：选「轻量层独立 crate + 重量层看 dev 是否在跑」。L0 用自有 target，任何时刻可跑；L1 复用主 target，由 `scripts/test-guard.ps1` 判断并拒绝。不额外开第二份全量 target。
5. **门禁与文档**：本地 pre-push 跑 L0（已接入 `scripts/push.ps1`），暂不上 CI。ADR 0005 已落；GLOSSARY 已收「红线」「常跑集」「隔离运行」。

## 10. 已落地（2026-11-16）

| 项 | 位置 | 现状 |
|---|---|---|
| L0-01/02 UTF-8 分块 | `src-tauri/core-domain/src/utf8_stream.rs` | 6 个用例，含「任意切分点」不变量 |
| L0-03~06 输入所有权与状态机 | `src-tauri/core-domain/src/ownership.rs` | 8 个用例，覆盖 ADR 0003 的场景表 |
| OSC 解析（A/B/C/D、CWD、备用屏） | `src-tauri/core-domain/src/osc.rs` | 13 个用例，含逐字节喂入与任意切分 |
| L1-06/07 真 pwsh 标记链路 | `src-tauri/core-domain/tests/pwsh_markers.rs` | 2 个用例，无窗口、缺 pwsh 自动 skip |
| 输出按帧聚合（M0 未达标项） | `src/main.ts` | 已改，等一次真实运行复测 |
| 输入所有权事件 | `src-tauri/src/main.rs` → `pty:ownership` | 判定只在变化时推送；前端只搬焦点，不复制规则 |
| 输入条最小版 | `index.html`、`src/main.ts`、`src/styles.css` | 三色状态点、回车发送、`Ctrl+Shift+P` 直通、`Ctrl+Shift+L` 锁定 |
| 集成脚本注入 | `spawn_session` | pwsh/powershell 用 `-NoExit -EncodedCommand <base64>` 注入脚本正文；bash 用 `--init-file`；都不写用户 profile |
| L1 bash 标记链路 | `src-tauri/core-domain/tests/bash_markers.rs` | A/C/D/退出码/CWD；找不到 Git Bash 自动 skip |
| 输入条历史 | `pty_send_line` / `pty_history` / `history:append` | M3 起落 `history.db`；`pty_history` 只是快照的只读视图，供 ↑↓ 用 |
| 回放缓冲 | `core-domain/src/replay.rs` | 15 个用例（L0-14）：序号、整块裁剪、超大单块保留、清空后序号继续、已答过的查询删除、清屏后留住当前行 |
| 工作区分格模型 | `core-domain/src/workspace.rs` | 16 个用例（L0-15）：开窗/切开/关闭折叠/交换、深度与唯一性校验、`set_cwd` 只报真变更、`rename_session` 的截断与拒绝 |
| 数据目录与原子写 | `src-tauri/src/persistence.rs` | 17 个用例（L1-08）：便携→APPDATA 回退、`PINSHELL_DATA_DIR` 优先、`.bak` 救回、双坏上报、工作区 JSON 往返、卷轴快照往返/覆盖/删除/文件名不许越界、覆盖写中途崩溃可从 `.old` 恢复 |
| 卷轴快照组装 | `core-domain/src/scrollback.rs` | 7 个用例（L0-16）：分隔线位置、去 OSC 标记、备用屏与隐藏光标开关被丢掉、末尾复位 |
| 卷轴快照落盘与还原 | `save_scrollback` / `spawn_session` / `on_window_event` | 进程退出、应用退出、输出静默 3 秒三处各写一次；冷会话重开时接在新输出前面；关闭会话（I2）删除 |
| 会话重命名 | `rename_session` + 侧栏双击 | 规则在 core-domain（L0-17），前端只送文本；冷会话重开不覆盖用户改过的名字 |
| M2 验收链路（手工） | `PINSHELL_DATA_DIR` 临时目录 + `npm run app:dev` | 首跑记下 CWD → 关窗写快照并留 `hot: false` → 重启读回 1 个冷会话并按 CWD 拉起 → 再关一次快照正好多一条分隔线；提示符后约 3 秒快照自动落盘（不用关窗）；可输入 795–820 ms |
| 会话树（冷/热） | `session_tree` + `src/main.ts` | 冷会话也在树里，`hot` 由 `pty_list` 对照；点冷会话用同一个 id 重新拉起，位置不变 |
| CWD 跟随 | `note_cwd` + `Workspace::set_cwd` | `OSC 7` 写进会话元数据；冷会话按记住的目录重开，目录没了退回默认目录；只在真变更时落盘 |
| 门禁取退出码 | `scripts/test-guard.ps1` | 改用 `[Diagnostics.Process]`：`Start-Process -PassThru` 在 PS 5.1 + 重定向下 `ExitCode` 为空，曾把全绿的层判成失败 |
| 页面重载挂回 | `pty_list` / `pty_replay` / `pty:out.seq` | 启动时挂回存活会话，回放 + seq 去重补画；窗口关闭才结束全部进程 |
| 「可输入」时刻 | `src/main.ts` → `applyOwnership` | 首个 `prompt_ready` 打 `[bench] input-ready`，口径为模块求值 → OSC 133 A；数字待下次手工运行采集 |
| 测试报告 | `scripts/test-guard.ps1` | 每次运行写 `tests/report/latest.json` 并追加 `docs/test-report.md`（留最近 10 次） |
| L0-18 历史规则 | `src-tauri/core-domain/src/history.rs` | 11 个用例：去重挪到最新、次数累加、封顶丢最旧、会话隔离、清空只作用当前会话且号不回退、检索大小写规则与排序、UTC → 本地日期与跨天锚点 |
| L1-10 历史库 | `src-tauri/src/history.rs` | 10 个用例：去重/次数/封顶跨重开、会话隔离、清空保留发号、删除节点销毁、快照窗口、全量检索、损坏库改名重建、未知会话空读、内存降级 |
| 历史落盘与事件 | `history_snapshot` / `history_search` / `history_clear` / `history:append` | WAL + 单写线程；先发 PTY 再异步写库；`id` 是会话内单调提交号（缺口即整份重建）；库坏降级内存并只发一次 `history:degraded` |
| L0-07 / L0-09 前端纯逻辑 | `src/history.ts` + `src/history.test.ts` | 11 个用例：Ghost Text 行尾/单行/非空白、最近优先、大小写、多行排除、5000 条 p99 < 1 ms（1000 次采样，单次 GC 停顿不翻红）；检索过滤；跨天/跨月/跨年锚点 |
| L2-02 历史缓存契约 | `src/historyCache.ts` + `src/historyCache.test.ts` | 9 个用例：快照带 `upto_id` 且只留 5000 条、`id` 严格 +1 才追加、跳号整份重建、重复投递丢弃、非当前会话事件忽略、切会话丢弃整份缓存、同命令挪到最新、追加也按 5000 条挤掉最旧 |
| Ghost Text | `src/main.ts` + `index.html` | 输入框后灰色建议，`→` 接受；建议不可选中，不改变输入直到被采纳 |
| Ctrl+R 覆盖层 | `src/main.ts` + `index.html` + `src/styles.css` | `Esc` 恢复草稿、`Enter` 只填充不发送、40 ms 防抖后查全量、日期分隔行、`更早` 标记、两段式「清空本会话」 |
| 输入条交互边界（M3 打磨） | `src/main.ts` + `src/styles.css` | 输入法组合期间不发送、不画建议（`isComposing` + `composing` 双保险）；手动编辑后 `↑↓` 游标归位，不再从旧位置跳条；切会话清空草稿、关掉覆盖层并丢掉旧会话缓存；覆盖层按键（`Esc` / `↑↓` / `Enter` / `Tab`）统一挂在容器上，点过「清空」「关闭」之后仍生效；长按 `Ctrl+R` 与 `Ctrl+Shift+P/L` 只切一次；长命令的 Ghost 跟随横向滚动并在输入条边缘截断；空白回车不发送；按键热路径上的诊断 IPC 默认关闭（`#debug` 才开） |
| 本地门禁 | `scripts/test-guard.ps1`（接入 `scripts/push.ps1`） | dev 在跑时自动只跑 L0 并说明原因；已验证「锁住 exe 时拒绝 L1」 |
| L0-19 清屏过滤 | `src/outQueue.ts` + `src/outQueue.test.ts` | 4 个用例：下限之前的块全部丢掉、全丢时序号归零、下限为 0 一块不丢、乱序到达按到达顺序拼并取最大序号 |
| 暂停 / 继续 | `pty_set_paused` / `pty_paused` + `src/main.ts` | 判定在后端读线程：暂停只掐 `pty:out` 事件，输出仍进回放缓冲（暂停多久都不会堆内存——攒着的合流块直接丢，回放自己按上限裁旧）；继续时整屏按回放重画，不把增量接在旧屏幕上；按钮状态按后端 `pty_paused` 复原，不靠前端记忆 |
| 一键清窗口 | `pty_clear` + `src/main.ts` | 清回放缓冲 + 删磁盘卷轴快照 + `term.clear()`；保留光标那一行（通常就是提示符）留在回放开头，切走再切回来、暂停后继续都还画得出来；返回清空前的最后序号，前端据此丢掉在途与已排队的旧块；不发 `Ctrl+L`、不动命令历史 |
| 输入条按钮行 | `index.html` + `src/main.ts` + `src/styles.css` | 暂停 / 清屏 / 直通 / 接管四个按钮与快捷键同源；`mousedown` 阻止默认，按钮不抢焦点，点完可以接着敲键盘 |
| 卷轴行数上限 | `src/main.ts` 的 `SCROLLBACK_LINES` | 取 5000 行（约 2 MB）；`scripts/bench-scrollback.mjs` 实测稳态吞吐与上限无关（52–57 MB/s）、内存约 0.4 KB/行，数字见 `docs/bench-m0.md` |
| 切会话 / 窗口缩放（手工回归） | `.probe/probe_switch_resize.ps1` | 侧栏行按无障碍文本定位再点（行高随 DPI 变，写死 y 会点到标题栏，结论是假的）；两个会话各留一条标记命令，切走再切回后磁盘快照里只有各自的标记（`MARK-A` 只出现在 423c、`MARK-B` 只出现在 c387），回放尾巴完整、无重影；窗口宽度 −300 px 后 Shell 里的 `$Host.UI.RawUI.WindowSize.Width` 由 172 变成 129（探针把它写进 `w_before.txt` / `w_after.txt` 核对），说明 resize 真下到了 PTY |
| M4 文件面板（第一片） | `core-domain/src/fsview.rs`、`src-tauri/src/fsview.rs`、`src/filePanel.ts`、`src/filePanelUi.ts` | `fs_list` 只读列目录（`path` 为空时跟随会话 CWD，读盘在阻塞线程池）；排序/隐藏过滤/截断/路径归一化在 core-domain（9 个用例）；`std::fs` 填元数据（跟随链接判类型、Windows 隐藏属性）3 个用例；`session:cwd` 只在 CWD 真变更时推；面板显示格式与跟随/固定选择 13 个前端用例；折叠/展开不抢焦点，切换后终端重新 fit |
| M4 文件面板（第二片：自动刷新） | `src/filePanel.ts`、`src/filePanelUi.ts`、`src/filePanel.test.ts` | 逐项比较 5 个用例（任一字段或顺序变了才算变化）、刷新间隔与失败退避 2 个用例（大目录 10 秒、2 的幂到 24 秒）、宽度夹取 5 个：合计 12 个前端用例。DOM 行为用假 IPC 的浏览器验证台确认：内容不变时 3 秒一次只发 `fs_list`、零 DOM 变更；内容变化时重绘 200 行且 `scrollTop` 与选中行都还在；面板收起、无会话时不发请求；大目录（`total > 1000`）周期变 10 秒；一次读盘失败后下一次等到 6 秒 |
| M4 文件面板（第三片：`..`、左栏调宽与收起） | `src/filePanelUi.ts`、`src/sidebar.ts`、`src/sidebarUi.ts`、`src/resize.ts`、`src/styles.css` | 两侧拖动共用同一套手势与 `body.layout-dragging`，拖动中只改 CSS、松手才 `layoutChanged`；左栏 150–360px，两栏各自量对方实时宽度定上限。两栏都能收起成 26px 竖条（左栏竖排「会话」展开按钮），折叠状态与宽度一起进 `localStorage`。前端用例 14 个（夹取 7、存储解析 5、序列化 2，坏数据回默认）。浏览器验证台确认：`..` 只在有父目录时出现、单击可选中、双击发出 `path=C:\`（转「固定」）、无父目录与空目录两种情况都对；左栏 196→297 拖动中零次重排、松手一次；拖到 +900px 被夹在 360；窗口缩到 700px 后两栏各自缩到 195/324、终端留住 180；点「‹」收起后宽度 27px、列表与手柄隐藏、展开按钮出现且 `layoutChanged` 一次，点展开恢复原宽度并再 `layoutChanged` 一次；收起状态重载页面后仍在（存的是 `{"width":195,"collapsed":true}`，展开回到 196） |
| 分层决策 | `docs/adr/0005-test-layering.md` | 已接受 |

跑法：`.\scripts\test-guard.ps1 -Layer all`（L0 用独立 target，`tauri dev` 跑着也能执行；L1 会被闸门跳过）。
