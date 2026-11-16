# 调研一：同类产品怎么做的

> 调研时间 2026-11。标记：**【查证】** 有官方文档/源码出处；**【推断】** 无直接证据；**【无数据】** 查不到可靠资料。

## 对比表

| 产品 | 技术栈 | 输入层解耦 | 状态判定手段 | 会话模型 | 还原 | 便携 | 串口 | 内存 |
|---|---|---|---|---|---|---|---|---|
| Warp | Rust + 自绘 GPU 渲染 | **是** | Shell 钩子发结构化 JSON（非正则） | 每条命令一个独立 grid | SQLite `warp.sqlite` 存窗口/标签/Block | 否 | 否 | 无数据 |
| Windows Terminal | C++/WinUI + AtlasEngine | 否 | OSC 133 A/B/C/D（用户自行注入） | 标签/分栏 | 只存布局 + CWD，不存内容 | Canary 有 Portable ZIP | 否 | 无数据 |
| Tabby | Electron + xterm.js | 否 | 无 | 标签 + SSH/串口连接 | 记得标签页 | 有（同级 `data`） | 有 | 官方自认不轻量 |
| Wave | Go 后端 + React | 否 | 私有 OSC 16162 | Command Block | durable SSH 会话跨重启 | 无数据 | 否 | 无数据 |
| VS Code | Electron + xterm.js | 否 | OSC 633（133 超集，自动注入） | 标签/分栏 | 布局恢复 | ZIP 版 | 无 | 无数据 |
| iTerm2 | macOS 原生 | 部分（Auto Composer 接管 prompt） | OSC 133 + 1337 + 正则兜底 | 标签/分栏 | 命令历史按 host 落盘 | 否 | 否 | 无数据 |
| WezTerm / Alacritty | Rust | 否 | OSC 7/133（需手动 source） | 标签/分栏 / 单窗口 | 无内置还原 | ZIP 版 | 无数据 | Alacritty 低 |
| MobaXterm / SecureCRT | 闭源 | 否 | 无 | 会话管理器 + 宏/按钮栏 | 会话自动保存 | 是【推断】 | **有** | 无数据 |
| ConEmu / Cmder | 闭源 + 打包 Clink | 否 | 无 | Task（预定义命令行）/ 标签 | 配置随身 | **是** | 否 | 无数据 |

## 关键要点

**Warp**【查证】
- 接管输入的做法是禁用 Shell 自己的行编辑（zsh 里 `unsetopt ZLE`），并在进入前清空 Shell 侧缓冲（`zle kill-buffer`），避免两边各存一份。PowerShell 走的是「移除 PSReadLine 再当隐式行编辑器复用」的路子。
- 状态判定靠 `precmd`/`preexec` 钩子推送 JSON（含 pwd、ps1、exit_code、next_block_id），**不解析提示符文本**。
- 传输私有数据在 Windows/WSL 上必须走 OSC，不能用 DCS——源码注释明写。
- 支持列表**不含 cmd.exe**。

**Windows Terminal**【查证】
- 只消费 OSC 133 / OSC 9;9(CWD) / OSC 9;4(进度)，脚本要用户自己塞进 profile，不做自动注入；cmd 连退出码都拿不到。
- 还原只到「窗口 + 标签 + 分栏 + CWD」，明确不存内容。

**VS Code**【查证】
- OSC 633 是 133 的超集，额外上报命令行文本并带 nonce 防伪造；靠改 argv/env **自动注入**，体验优于 WT。
- 官方文档承认：ConPTY 下标记位置会错位，装饰条只能靠启发式修补。这是「在 ConPTY 上做块级 UI」的通用税。

**Tabby / Wave / Fluent / Hyper**【查证】
- Tabby 有串口与便携 `data` 目录，但 README 直言「不轻量，在意内存请用别的」。
- Wave 的私有 OSC 里有一条 **R = 复位备用屏**，能从 `less`/`vim` 崩溃后卡在全屏状态里自动恢复——这是很实用的细节。
- Fluent Terminal 已停维护。

**ConEmu / Cmder**【查证】
- Task = 具名命令行集合，可一次开多标签；宏 = 录键回放。Cmder 就是 ConEmu + Clink + Git for Windows 的便携打包。我们的「命令片段」在概念上更接近 Task，但要按会话存。

## 值得借鉴

1. 用 Shell 钩子推结构化数据，不做提示符正则匹配。
2. 接管输入后，务必清空 Shell 侧行编辑缓冲，否则会双份状态。
3. 提供「复位备用屏」这种自愈指令，应对全屏程序异常退出。
4. 持久化分层：布局/CWD 这类轻量元数据与内容快照分开存。
5. 私有协议在 ConPTY 下一律用 OSC。

## 别学的

1. 依赖用户手改 `PROMPT`/`PS1` 才有效——覆盖率天然残缺。
2. 假设 ConPTY 能把标记位置原样送到——做不到，得自己在终端侧兜底。
3. 用 DCS 传私有数据。
4. 把宿主 Shell 的行编辑器当隐式缓冲（会与其历史、键位互踩，还要处理 PSReadLine 在非 VT 环境下不可用的情况）。
5. 用 Electron 这类重框架做「轻量快速」卖点。

## 对本项目的直接含义

- 我们的差异点（输入条接管）在 Windows 上**没有现成产品做全**：Warp 不做 cmd，VS Code/WT 不解耦输入，Tabby 不解耦。这意味着风险高、但确实是空白。
- 判定协议必须自己定义并写成规范（见 ADR 0003 / 调研三），且必须把「猜测」与「确知」严格分层。
