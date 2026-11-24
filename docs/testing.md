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
| L0-20 | 文件面板显示规则 | 目录优先且大小写不敏感排序、隐藏项过滤与计数、2000 条截断、路径归一化与父/子拼接、盘符根与 UNC 根、大小与时间格式、跟随/固定模式的目标路径、降级菜单的项集合与视口夹取、会话级偏好的解析与迁移（旧版全局配置落到默认值、跟随模式不保留固定路径、脏字段逐项回退） |
| L0-21 | 端口下拉文案 | 产品名 > 厂商名 > 通道类型逐级回退；空字符串当作没有，不画出「COM3 · 」；假串口带自己的标签 |
| L0-22 | 功能栏面板模型 | 顺序表补齐缺项、丢掉不认识的 id 与重复项；上下移动到头原样返回；勾选不影响顺序表；最后一个「可见且展开」的面板吃剩余高度、全折叠时为空；高度夹取下限 120px、上限为可用高度的 70% |

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
| M4（已完成） | 文件面板跟随 CWD / 自动刷新 / 拖宽收起、原生右键菜单与降级 | L0-20、L3-06、手工（helper 崩溃降级） |
| M5（已完成） | 串口通道、假 Transport、HEX 与日志 | L0-10、L0-12、L0-13（I4）、L0-21、主 crate 的 `transport` 用例 + 手工清单（假串口回环、真串口对） |
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

- 性能数字应使用 release 构建，并记录机器、Shell、会话数和运行条件；开发构建只用于趋势观察。
- 当前 `src/main.ts` 基准仅在 URL hash 为 `#bench` 时启动，普通启动不执行额外 IPC 循环或离屏 xterm 写入。它测得的 1 MB 指标是离屏 xterm 解析/写入时间，不代表可见 WebView 的帧率；按键端到端延迟与 1/5/10 会话空闲 CPU 仍需桌面采样。
- `refreshTree()` 获取活会话运行状态使用批量 `session_runtime_states` 命令，不应恢复为逐会话 IPC 查询；测试应覆盖暂停状态 revision 并发保护。
- 后端静默猜测与卷轴落盘由共享调度线程维护。多会话空闲 CPU 与线程数必须实测，避免把线程数下降误报为 CPU 或响应时间已改善。
- 同一台机连跑 5 次取中位数；单次偏离中位数 > 20% 视为噪声样本，重跑一次再判。
- 采集结果写成 JSON（`tests/report/latest.json`），不靠人读 HUD。性能数字仍由 `[bench]` stdout 行提供（`input-ready` 一行给「可输入」），脚本化采集待补。

## 6. 运行手册

| 命令 | 内容 | 实测耗时 | 前置条件 |
|---|---|---|---|
| `.\scripts\test-guard.ps1 -Layer l0` | 常跑集：core-domain 纯逻辑 + 前端纯逻辑（独立 target、子进程降优先级） | 1–2 s | 无 |
| `npm test` | 只跑前端纯逻辑（Ghost Text / 检索 / 跨天锚点 / 历史缓存 / 清屏过滤），vitest、node 环境 | ~1 s | 无 |
| `.\scripts\test-guard.ps1 -Layer it` | L1：真 pwsh/bash 标记链路 + 主 crate 单元测试（持久化、历史库、transport） | ~2–6 s | dev 未运行；否则拒绝执行并返回 1 |
| `.\scripts\test-guard.ps1 -Layer all` | 两层；dev 在跑时只跑 L0 并打印原因 | ~1 s | 无 |
| `$env:CARGO_TARGET_DIR="<repo>\src-tauri\target-m5"` 后 `.\scripts\test-guard.ps1 -Layer all -Force` | dev 在跑、又必须跑 L1 时：换一份独立 target，不碰被占用的 `target\debug`，也就不用停 dev | 首次全量编译几分钟，之后 ~3 s | 磁盘多一份 target（`src-tauri/target-*/` 已忽略）；`-Force` 只跳过闸门判断，不跳过测试 |
| `.\scripts\push.ps1` | 先跑 L0 门禁再推；`-SkipTests` 可跳过 | +0.5 s | 无 |

前端单测已接入：`src/history.ts`（Ghost Text / 检索 / 跨天锚点）、`src/historyCache.ts`（历史缓存契约）、`src/outQueue.ts`（清屏后的输出过滤）、`src/findBar.ts`（查找偏好 / 命中序号 / 到头判定 / 插件契约）、`src/findBarUi.test.ts`（查找条状态机，happy-dom + 桩插件）、`src/findBarAddon.test.ts`（真实插件的折行 / 大小写 / 绕回）、`src/sessionDialogUi.ts`（端口下拉文案）、`src/displaySettings.ts`（字号区间收敛）、`src/i18n.ts`（中英文词典与占位符）与 `src/theme.ts`（主题偏好与终端配色）都是值得测的纯函数模块，用 vitest（默认 node 环境，不起窗口、不占 1420；查找的两条 DOM 用例按文件切到 happy-dom），已并入 L0 门禁。L3 性能采集仍然靠 `npm run app:dev` 手工采集；卷轴上限的吞吐与内存用 `scripts/bench-scrollback.mjs` 单独测（不依赖窗口）。

## 7. 汇报（已落地）

- 机器可读：`tests/report/latest.json`，每次门禁运行覆盖重写。含各层状态与耗时、用例逐一状态、`skip_reason`、`forced`（是否 `-Force` 强跑）。**没有逐例耗时**：libtest 的耗时报告仍是 nightly 特性，不为此换工具链。
- 人可读：`docs/test-report.md` 每次运行追加一行，只留最近 10 次；红的用例在最后一列点名（写作 `L0/模块::用例`）。
- 被跳过的层也算一次记录：`status = skipped` 带上原因（如 `tauri dev is running`），不会被误读成「通过」。
- 常跑失败时的动作：不打断人，报告里已有失败用例名与复现命令（`.\scripts\test-guard.ps1 -Layer l0`），等人有空处理。

## 8. 现在测不了的东西（诚实清单）

| 项 | 原因 | 什么时候能测 |
|---|---|---|
| 真 GUI 自动化 | 未装 `tauri-driver` + 匹配 WebView2 的 `msedgedriver`，且会抢焦点 | 等确认是否值得装 |
| 串口真设备 | 假 Transport 已覆盖组包、释放/重开与日志；真设备与 com0com 之类的虚拟串口对仍靠手工（装驱动 = 打扰） | 已列入 §8.2 手工清单 |
| 原生菜单 helper 隔离 | 已落地：helper 是独立进程，崩溃/缺失都降级为自建菜单；崩溃场景本身靠手工（结束 helper 或换成坏 exe 后右键仍能出菜单） | 手工清单 |
| IME / 多显示器 / 字体回退 / 高 DPI | GUI 环境相关，自动化收益低 | 手工清单 |
| 多窗口（单主窗口之外的场景） | 产品未做 | 后续 |

### 8.1 M4 右键菜单手工清单（改过 helper 或打包配置后走一遍）

| 项 | 步骤 | 期望 |
|---|---|---|
| 原生菜单 | `npm run app:dev`，右键文件面板里的文件 | 弹出资源管理器菜单，「打开方式」「发送到」与第三方扩展（7-Zip、TortoiseGit 等）都在；选一项能真的执行 |
| 空白处背景菜单 | 右键文件列表的空白处（或「（空目录）」提示） | 弹出该目录的背景菜单（新建 / 粘贴 / 属性等，与资源管理器右键空白处同源）；选「新建 → 文本文档」能在当前目录建出文件 |
| F5 刷新 | 单击文件列表空白处后按 `F5` | 列表立刻重读当前目录；焦点在终端时 `F5` 仍发给 Shell，不会刷新面板 |
| 路径栏 | 单击面包屑里的某一级名称；点 `✎` 或双击路径栏空白处输入 `C:\Windows` 回车 | 名称单击直接进入该级目录；编辑后回车跳转、`Esc` 取消；输入不存在的路径显示错误并可继续编辑 |
| 取消 | 原生菜单或背景菜单打开时，点菜单外面或按 `Esc` | 菜单消失，会话、输入条、自动刷新都正常 |
| 缺失降级 | 把 `src-tauri\target\debug\pinshell-shellmenu.exe` 改名后右键 | 出四项自建菜单（打开 / 在资源管理器中显示 / 复制路径 / 填入输入条），空白处出（打开 / 在资源管理器中显示 / 复制路径 / 刷新）；主进程不崩；改回名字并重启应用后恢复原生 |
| 崩溃降级 | 用一个立刻退出的 exe 覆盖 helper（或启动应用前把 `PINSHELL_SHELLMENU` 指向它） | 同上降级，主进程存活，能继续切会话 |
| 安装版 | 装 `src-tauri\target\release\bundle\nsis\PinShell_0.1.0_x64-setup.exe` 后右键 | 安装目录里有 `pinshell-shellmenu.exe`，右键仍出原生菜单；卸载后不残留 |

打包这一项已自动核对：`npm run app:build` 产出的 MSI 与 NSIS 里各只有一份 `pinshell-shellmenu.exe`（生成的 `main.wxs` 与 `installer.nsi` 各一行），文件名与运行时查找的名字一致。

### 8.3 会话设置、实时日志与文件栏跟随

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| Shell 实时日志 | 对 Shell 会话选择“设置”，选择临时目录并启用保存；执行两行命令并输入一条命令 | 文件按模板创建；收到的 Shell 输出按行写入，用户发送行带 `[TX]`；保存开关关闭后文件可完整读取 |
| 时间戳目标 | 分别只开控制台、只开文件，再同时开启；使用 `yyyy-MM-dd HH:mm:ss.SSS` 默认值 | 两个目标独立生效，完整行每行仅加一次时间戳 |
| 串口 CR 处理 | 假串口或真串口发送 `A\rB\r\nC`，设置里打开「单独的 \r 视为换行」 | 屏幕显示为三行，CRLF 不产生额外空行；会话日志里同样是 CRLF 断行（Windows 编辑器能正常分行），内部诊断日志仍保留原始数据 |
| 串口参数 | 在连接状态修改波特率/数据位/校验/停止位/流控 | 波特率可从常用值下拉，也可直接输入别的值；端口只读（要换口请新建一个串口会话，在对话框里选）；保存后释放并按新参数重连；设备不接受参数时显示错误并保持断开 |
| 暂停/继续切日志 | 勾选“暂停/继续（连接/断开）时新建日志文件”，暂停再继续并产生输出 | 切换后的第一条记录写进新的编号文件；不勾选时继续写同一个文件；暂停那一刻不留下空日志 |
| 文件名冲突 | 在同一秒内启动两次保存，保持相同模板 | 后一次创建带序号的新文件，不覆盖原日志 |
| 目录与跟随 | 选择日志目录，启用保存，文件栏保持“跟随”；停止保存 | 文件栏定位日志目录；停止后仍留在该目录；打开日志文件夹调用系统文件管理器 |
| 冷会话 | 保存设置、退出并重新启动，打开对应 Shell/串口会话 | 时间戳、CR 选项、目录和模板恢复；日志默认停止，避免未启动的会话创建日志文件 |

### 8.4 功能栏（ADR 0007）

| 项 | 步骤 | 期望 |
|---|---|---|
| 位置与标题 | 看右栏从上到下 | 快捷指令 / 串口列表 / 文件；串口那块标题写「串口列表」，而会话行副标题、输入条摘要仍写「串口 COM3 · 115200」 |
| 只读 | 串口列表里看每一行、右键行、双击行 | 没有行内 ＋；右键不弹菜单；单击与双击都不做事；列表只随枚举结果变化 |
| 高亮 | 焦点切到串口会话，再切回终端会话 | 串口会话时占用那一行高亮；终端会话时整列都不高亮 |
| 创建入口 | 项目行「＋」→ 新建会话弹窗 → 传输方式选「串口」 | 端口可手输，也可点 `▾` 从枚举列表挑；同一弹窗里选落点（默认向右切） |
| 勾选 | 全局设置 → 功能栏，取消「串口列表」 | 右栏立刻没有它，另外两个照常；重新勾上时回到原来的位置 |
| 排序 | 把「文件」用 ↑ 移到第一 | 文件按自己记住的高度（默认 260）显示，最后一个面板（例如串口列表）撑满，它的高度手柄消失 |
| 全不勾 | 三个都取消 | 整条右栏消失，标题栏右侧按钮置灰、提示「功能栏已全部关闭（在全局设置里打开）」；重新勾一个即恢复 |
| 全折叠 | 三个面板都点标题栏收起 | 右栏下方留一块空白，不会把别的面板撑开 |
| 即时生效 | 在设置里改勾选/顺序，按 `×` 或 `Esc` 关闭 | 右栏在改的当下就跟着变；关闭方式不影响结果，没有「放弃修改」 |
| 持久化 | 改完顺序、勾选与高度后重开应用 | 三者都还原；`localStorage` 的 `pinshell.rightbar` 存 `{order, hidden}` |

### 8.2 M5 串口手工清单（改过 transport / 发送组包 / 日志后走一遍）

没有硬件也能先走前四项：启动前设 `PINSHELL_FAKE_SERIAL=1`，端口列表里会出现 `PINSHELL_LOOP`（内存回环，不碰系统端口）。

| 项 | 步骤 | 期望 |
|---|---|---|
| 新建与回显 | `PINSHELL_FAKE_SERIAL=1` 后点项目行「＋」→ 新建会话弹窗选「串口」，端口选 `PINSHELL_LOOP`，创建 | 会话出现在项目行下（行首带 `⌁`，标题就是 `PINSHELL_LOOP`，不再带波特率）；屏幕先出一行「PinShell 假串口」；输入条显示 `串口 PINSHELL_LOOP · 115200 8N1`；回车后内容原样回显 |
| HEX | 点输入条「HEX」，输入 `41 54 0D 0A` 回车 | 屏幕回显 `AT`（不带行结束符）；输入 `ABC` 回车 → 提示「十六进制位数是奇数」，这一行留在输入条上；`0x41` → 指出 `x` 不是十六进制数字 |
| 报错不吞输入 | HEX 下输入 `AAA` 回车，或断开端口后随便发一行 | 报错浮在输入条上方、单独占一行，不挤占输入框；这一行仍完整留在输入框里，可以直接改（实测提示 205 px 时输入框仍留 163 px） |
| 重连清提示 | 断开 → 发一行（出现「端口已断开，先点『连接』」）→ 点「连接」 | 提示立即消失；不会出现状态点已经绿的、提示还写着已断开的画面 |
| 行结束符 | 分别用 CRLF / CR / LF 创建一个会话，发送 `AT` | 日志里 TX 分别是 `AT\r\n` / `AT\r` / `AT\n`；假串口不写日志，看屏幕回显的换行也够（LF 会话的卷轴快照末尾就是 `0a`） |
| 日志 | 真串口会话点「日志」（假串口的 `PINSHELL_LOOP` 不写日志，按钮是灰的） | 用系统关联打开 `data/logs/serial-*.log`；头部有端口/波特率/8N1，正文按 `[TX +毫秒]` / `[RX +毫秒]` 记录，二进制字节写成 `\xNN` |
| 断开即释放 | 真串口（或虚拟串口对）上点「断开」（按钮文字是「断开」时的那个动作） | 按钮变成「连接」、状态点转琥珀；用另一个串口工具能打开同一个端口；再点「连接」恢复收发，回放与历史都还在 |
| 同一端口单热会话（I4） | 已有一个 `COM3` 热会话时再建一个 `COM3` | 对话框里显示「已被另一个会话占用」，不创建；暂停（已断开）的会话同样占名额 |
| 拔线可重连 | 会话进行中拔掉 USB 转串口 | 状态变「连接失败」、屏幕保留已有内容；插回后点「连接」按原配置重开，能继续收发 |
| 能力位 | 串口会话里看输入条 | 没有 Ghost Text、Ctrl+R 无反应；↑↓ 仍能翻本会话发送过的行；文件面板回退到用户主目录（串口没有 CWD） |
| 冷会话 | 关掉应用重开，点树里的串口会话 | 按记住的参数重连；屏幕先画回上次内容与分隔线；标题不覆盖用户改过的名字 |

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
| 冻结会话 | 右键热会话 → 冻结会话 | 进程/端口结束、行变冷（状态点熄灭），记录、命令历史与屏幕快照都还在；点该行按原参数重新拉起并接回上次屏幕。冻结当前会话时自动切到另一个会话；冷会话上该项禁用 |
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
| 查找（Ctrl+Shift+F） | `src/findBar.ts` + `src/findBarUi.ts` + `src/findBarAddon.test.ts` + `src/styles.css` | 每分格一条、只搜前端缓冲区（ADR 0009）；`Ctrl+Shift+F` 独占，`Ctrl+F` 留给 Shell 的 forward-char；Enter / Shift+Enter 走命中；循环关掉后在两端给「已经到头了」；切走隐藏、切回还原；清屏关闭；高亮上限 1000。折行、大小写、绕回由 `findBarAddon.test.ts` 钉住（happy-dom 下 `open()` 过真 xterm；纯 Node 没有 selection service，插件会抛 `TypeError`） |
| 输入条交互边界（M3 打磨） | `src/main.ts` + `src/styles.css` | 输入法组合期间不发送、不画建议（`isComposing` + `composing` 双保险）；手动编辑后 `↑↓` 游标归位，不再从旧位置跳条；切会话清空草稿、关掉覆盖层并丢掉旧会话缓存；覆盖层按键（`Esc` / `↑↓` / `Enter` / `Tab`）统一挂在容器上，点过「清空」「关闭」之后仍生效；长按 `Ctrl+R` 与 `Ctrl+Shift+P/L` 只切一次；长命令的 Ghost 跟随横向滚动并在输入条边缘截断；空白回车不发送；按键热路径上的诊断 IPC 默认关闭（`#debug` 才开） |
| 本地门禁 | `scripts/test-guard.ps1`（接入 `scripts/push.ps1`） | dev 在跑时自动只跑 L0 并说明原因；已验证「锁住 exe 时拒绝 L1」 |
| L0-19 清屏过滤 | `src/outQueue.ts` + `src/outQueue.test.ts` | 4 个用例：下限之前的块全部丢掉、全丢时序号归零、下限为 0 一块不丢、乱序到达按到达顺序拼并取最大序号 |
| 暂停 / 继续 | `pty_set_paused` / `pty_paused` + `src/main.ts` | 判定在后端读线程：暂停只掐 `pty:out` 事件，输出仍进回放缓冲（暂停多久都不会堆内存——攒着的合流块直接丢，回放自己按上限裁旧）；继续时整屏按回放重画，不把增量接在旧屏幕上；按钮状态按后端 `pty_paused` 复原，不靠前端记忆 |
| 一键清窗口 | `pty_clear` + `src/main.ts` | 清回放缓冲 + 删磁盘卷轴快照 + `term.clear()`；保留光标那一行（通常就是提示符）留在回放开头，切走再切回来、暂停后继续都还画得出来；返回清空前的最后序号，前端据此丢掉在途与已排队的旧块；不发 `Ctrl+L`、不动命令历史 |
| 输入条按钮行 | `index.html` + `src/main.ts` + `src/styles.css` | 暂停 / 清屏 / 直通 / 接管四个按钮与快捷键同源；`mousedown` 阻止默认，按钮不抢焦点，点完可以接着敲键盘 |
| 卷轴行数上限 | `src/main.ts` 的 `SCROLLBACK_LINES` | 取 5000 行（约 2 MB）；`scripts/bench-scrollback.mjs` 实测稳态吞吐与上限无关（52–57 MB/s）、内存约 0.4 KB/行，数字见 `docs/bench-m0.md` |
| 切会话 / 窗口缩放（手工回归） | `.probe/probe_switch_resize.ps1` | 侧栏行按无障碍文本定位再点（行高随 DPI 变，写死 y 会点到标题栏，结论是假的）；两个会话各留一条标记命令，切走再切回后磁盘快照里只有各自的标记（`MARK-A` 只出现在 423c、`MARK-B` 只出现在 c387），回放尾巴完整、无重影；窗口宽度 −300 px 后 Shell 里的 `$Host.UI.RawUI.WindowSize.Width` 由 172 变成 129（探针把它写进 `w_before.txt` / `w_after.txt` 核对），说明 resize 真下到了 PTY |
| M4 文件面板（第一片） | `core-domain/src/fsview.rs`、`src-tauri/src/fsview.rs`、`src/filePanel.ts`、`src/filePanelUi.ts` | `fs_list` 只读列目录（`path` 为空时跟随会话 CWD，读盘在阻塞线程池）；排序/隐藏过滤/截断/路径归一化在 core-domain（9 个用例）；`std::fs` 填元数据（跟随链接判类型、Windows 隐藏属性）3 个用例；`session:cwd` 只在 CWD 真变更时推；面板显示格式与跟随/固定选择 13 个前端用例；折叠/展开不抢焦点，切换后终端重新 fit |
| M4 文件面板（右键菜单） | `src-tauri/src/bin/shellmenu.rs`、`src-tauri/src/shellmenu.rs`、`src/filePanelUi.ts`、`src/filePanel.ts` | helper 独立进程走 `IContextMenu`（STA、光标定位、`TPM_RETURNCMD`）；条目菜单用 `GetUIObjectOf`，列表空白处的背景菜单用 `IShellFolder::CreateViewObject` 请求 `IContextMenu`（`--background`，probe 在 `F:\PinShell` 实测生成 10 项）；主进程最多等 10 分钟，缺失/崩溃/超时都返回 `unavailable` 并由前端画降级菜单；`fs_open` / `fs_reveal` 走系统关联；`rowMenu`、`blankMenu`、`clampMenuPosition`、`pathSegments` 由 13 个前端用例覆盖；helper 的 `--probe` 只跑到 `QueryContextMenu` 就退出（不弹菜单）；helper 是普通 `[[bin]]`，`app:build` 随 crate 一起编译并打进 MSI/NSIS（tauri-cli 2.12 自动收录 bin；再声明 `externalBin` 会把同一个文件装两遍，WiX 以 ICE30 拒绝链接）；「没有 helper / 路径写错 / 启动失败」三条降级路径由 3 个 Rust 用例覆盖，崩溃与超时仍靠手工 |
| M4 文件面板（第二片：自动刷新） | `src/filePanel.ts`、`src/filePanelUi.ts`、`src/filePanel.test.ts` | 逐项比较 5 个用例（任一字段或顺序变了才算变化）、刷新间隔与失败退避 2 个用例（大目录 10 秒、失败按 2 的幂退避）、宽度夹取 5 个：合计 12 个前端用例。DOM 行为用假 IPC 的浏览器验证台确认：内容不变时 1 秒一次只发 `fs_list`、零 DOM 变更；内容变化时重绘 200 行且 `scrollTop` 与选中行都还在；面板收起、无会话时不发请求；大目录（`total > 1000`）周期变 10 秒；一次读盘失败后下一次等到 2 秒 |
| M4 文件面板（第三片：`..`、左栏调宽与收起） | `src/filePanelUi.ts`、`src/sidebar.ts`、`src/sidebarUi.ts`、`src/resize.ts`、`src/styles.css` | 两侧拖动共用同一套手势与 `body.layout-dragging`，拖动中只改 CSS、松手才 `layoutChanged`；左栏 150–360px，两栏各自量对方实时宽度定上限。两栏都能收起成 26px 竖条（左栏竖排「会话」展开按钮），折叠状态与宽度一起进 `localStorage`。前端用例 14 个（夹取 7、存储解析 5、序列化 2，坏数据回默认）。浏览器验证台确认：`..` 只在有父目录时出现、单击可选中、双击发出 `path=C:\`（转「固定」）、无父目录与空目录两种情况都对；左栏 196→297 拖动中零次重排、松手一次；拖到 +900px 被夹在 360；窗口缩到 700px 后两栏各自缩到 195/324、终端留住 180；点「‹」收起后宽度 27px、列表与手柄隐藏、展开按钮出现且 `layoutChanged` 一次，点展开恢复原宽度并再 `layoutChanged` 一次；收起状态重载页面后仍在（存的是 `{"width":195,"collapsed":true}`，展开回到 196） |
| M4 文件面板（第四片：设置绑定会话） | `src/filePanel.ts`、`src/filePanelUi.ts`、`src/filePanel.test.ts` | 「跟随 / 固定」「自动」「隐」改为**会话级**：存储形如 `{expanded, width, defaults, sessions: {id: {mode, auto, showHidden, path}}}`，切会话先回写上一个会话、再换上新会话的一套；旧版顶层全局配置迁移成 `defaults`，已有会话不被重置。前端用例 6 个（旧版迁移、两会话互不影响、跟随不保留固定路径、脏字段逐项回退、宽度坏值、空存储默认值）。假 IPC 验证台确认：s1 开「隐」+「自动」、s2 关「隐」并转「固定」后，来回切换分别恢复成 `跟随/隐开/自动开` 与 `固定/隐关/自动开`，重载页面后两套仍在，`localStorage` 里两个会话各一条记录 |
| M5 串口规则（L0-10 / L0-12 / L0-13 的 I4） | `src-tauri/core-domain/src/serial.rs` | 14 个用例：HEX 分隔符/大小写/奇数位/非法字符位置/往返、CRLF-CR-LF 字节、行缓冲与直发组包、HEX 不追加结束符、8N1 默认值与端口/波特率校验、标题截断、能力位、端口比较不区分大小写、同一端口单热会话、日志转义与文件名安全化 |
| M5 通道抽象与假 Transport | `src-tauri/src/transport.rs` | `Transport` trait 统一终端与串口；`PtyTransport` 收下 resize 去重；`SerialTransport` 读写/释放/重开/日志；`MemoryTransport` 回环（`PINSHELL_FAKE_SERIAL=1`）。10 个主 crate 用例：能力位、写读往返、释放后读端结束且写入报错、重开后能继续收发、回环横幅与回显、端口数字排序、日志方向与转义、枚举不 panic、HEX 预览、发送方式标签 |
| M5 串口会话生命周期 | `spawn_serial_session` / `serial_connect` / `serial_disconnect` / `pty_set_paused` | 暂停即真释放（丢写句柄并 join 读线程）；重连先丢弃失败句柄再重开；失败后会话保持热；I4 由 `conflicting_session` 判定且在 `spawn_serial_session` 与 `connect_serial` 两处生效；串口读线程不喂 OSC、更新静默时间、写原始日志；冷会话按工作区配置重连 |
| M5 工作区 v2 | `src-tauri/src/persistence.rs` | `WORKSPACE_VERSION = 2`，会话多一个可选 `serial` 段；2 个用例：串口配置往返一致、v1 文件无 serial 字段照常读回为冷会话 |
| M5 前端 | `index.html`、`src/main.ts`、`src/sessionDialogUi.ts`、`src/styles.css` | 新建会话弹窗（传输方式、名称、终端 profile/起始目录、串口端口枚举/手输、8N1 各项、DTR/RTS、行结束符、发送方式、落点、错误原文回显）；项目行下的串口记号；输入条 `串口 COM3 · 115200 8N1` 摘要与连接失败原因；「暂停」显示成「断开 / 连接」；HEX 开关按会话记忆；「日志」按钮用系统关联打开；没有 Ghost Text 与 Ctrl+R，↑↓ 保留发送历史；发送失败把这一行放回输入条。端口下拉文案由 `src/sessionDialogUi.test.ts` 的 3 个用例覆盖（L0-21：产品名/厂商名/类型逐级回退、空串当没有、假串口自带标签） |
| ADR 0007 功能栏（L0-22） | `src/rightBar.ts`、`src/rightBarUi.ts`、`src/globalSettingsUi.ts`、`src/serialPortsPanelUi.ts`、`index.html`、`src/styles.css` | 可见性/顺序/填充规则 14 个用例（坏数据回默认、缺项补齐、去重与未知 id、移动边界、勾选不改变顺序、填充跳过隐藏与折叠、高度夹取）。假 IPC 的浏览器验证台确认：设置里三行始终都在且 ↑↓ 首尾置灰；取消勾选后面板立刻消失、重新勾上回原位；把「文件」移到第一后它按 260px 显示、最后一个面板撑满且手柄隐藏；三个全不勾时 `#files` 挂 `no-panels`、标题栏按钮 `disabled` 且提示改文案；新建会话弹窗在功能栏装配后仍可从项目行「＋」打开 |
| M5 验收 | 自动层 | `L0` 门禁：core-domain 117 个用例 + 前端 91 个用例全绿；`L1` 门禁：主 crate `cargo test --bin pinshell` 48 个用例（含 transport 10 个、persistence v2 2 个）+ 真 pwsh/bash 标记 3 个全绿。dev 正在跑，这一轮用独立 target 目录 `src-tauri\target-m5` 执行，没有碰被占用的 `target\debug`（跑法见 §6）。GUI 手工项见 §8.2（假串口回环先行；真设备/虚拟串口对按清单走） |
| 会话实时日志与 CR 显示 | `session_log` 与会话设置 | 串口单独 CR 转 LF（包括跨读取块 CRLF）；接收与发送写入独立用户日志；文件名按 `%Y%M%D-%h%m%s.log` 本地时间格式化并自动编号；时间戳分别控制控制台和文件；工作区保存目录与设置。菜单中支持串口参数/CR、Shell 与串口时间戳、目录选择和系统打开目录。文件栏跟随优先采用日志目录，无目录时保留 CWD/主目录逻辑。真串口重连与 Explorer 操作按 §8.3 手工验证。 | |

跑法：`.\scripts\test-guard.ps1 -Layer all`（L0 用独立 target，`tauri dev` 跑着也能执行；L1 会被闸门跳过。dev 在跑又必须跑 L1 时，按 §6 表格最后一行先设 `CARGO_TARGET_DIR` 再加 `-Force`）。
