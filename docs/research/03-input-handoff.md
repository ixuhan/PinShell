# 调研三：怎么判断「Shell 正在等命令」

> 结论先行：没有任何单一信号能可靠判断「Shell 在等输入」。唯一稳健做法是——**以 Shell 侧上报的提示符标记为主状态源，用备用屏与超时启发式兜底，并把「未知」当作一等状态**。Windows 上 cmd.exe 没有可用钩子，只能降级。

## 可用信号

| 信号 | 覆盖范围 | 可靠性 | 代价 |
|---|---|---|---|
| OSC 133 `A/B/C/D` | bash≥4.4、zsh、fish、pwsh、nushell（WSL/Git Bash 同 bash） | 装了脚本=高；未装=零 | 低 |
| OSC 633（VS Code 变体） | 同上，但需 VS Code 的注入方式 | 高，含命令行文本与 nonce | 中 |
| 备用屏 `?1049/?1047/?47` | 与 Shell 无关，ssh 内 vim 同样成立 | 高，但只管全屏程序 | 极低 |
| 括号粘贴 `?2004` | readline 8.1+ / zsh | 中（PSReadLine 时序无文档） | 低 |
| OSC 7 / OSC 9;9（CWD） | 装了脚本才准；WT 用的是 9;9 | 中 | 低 |
| `cmd` 的 `PROMPT` 注入 | 仅 cmd；无退出码 | 低 | 低（改用户环境） |
| 「光标在行首 + 静默 N 毫秒」 | 全部 | 低，误判多 | 极低 |
| ConPTY 前台进程/子进程状态 | — | **不可行**：ConPTY 只有两条字节管道，无状态查询；Windows 无 Unix 式前台进程组 | — |

## 推荐状态机

```
Unknown ──133;A──► Prompt ──133;C──► Running ──133;D──► Prompt
   │                 │                  │
   │                 └─DECSET 1049──► AltScreen ──DECRST──► Unknown
   └─静默+行首──► PromptGuess（只做 UI 提示，永不接管按键）
```

- **Unknown**：没收到任何标记。按键全透传。
- **Prompt**：收到 `A` 且未收到 `C`。允许输入条接管。
- **Running**：收到 `C`；或已回车但 N 毫秒内没有新 `A`。全透传。
- **AltScreen**：优先级最高，强制透传；退出后回 **Unknown**（无法知道是谁退出的）。
- **PromptGuess**：只驱动提示性 UI，不参与按键归属。

## 三条降级路径

1. **集成脚本未装**：永不进入 Prompt，只有 AltScreen + PromptGuess；输入条默认收起，提供「一键安装集成脚本」入口。
2. **cmd 无钩子**：最多通过 `PROMPT` 拿到 `A/B`（无 `C/D`、无退出码）；再不行等同未装，并把 `cmd /c`、`pause` 一律视为 Running。
3. **ssh 嵌套**：本地只能看到 ssh 客户端这一层。远端 vim 仍可由备用屏识别；远端提示符要靠远端装脚本；tmux 需开 passthrough 才能透传标记。

## 已知失效场景

1. 密码提示（sudo/ssh/passwd）：没有 `C/D`，光标在行首 → 会被误判成 Prompt。
2. `pause` / `set /p` / `read`：程序在等输入，但状态是 Running。
3. `cmd /c` 一次性命令：无钩子，状态卡住。
4. REPL（python/node/sqlite）：`C` 之后永远等不到 `D`。
5. `git commit` 打开编辑器：`D` 被推迟到编辑器退出后。
6. 长时间静默的构建（cargo build）：超时启发式误判。
7. tmux/screen 未开 passthrough：标记被吞。
8. 管道（`make | tee`）：静默期更长。
9. PowerShell 无 PSReadLine（`-NonInteractive`）：没有 `C` 也就没有 `D`。
10. Ctrl+C 中断命令：`D` 可能缺失。
11. 连续启动两个全屏程序：`DECRST/DECSET` 抖动，事件顺序不可靠。
12. ConPTY 重绘：标记位置可能错位。

## 对本项目的判断

- 必须自己定义一套**协议**而不是依赖单一序列：主用 OSC 133，扩展几条私有语义（备用屏复位、命令片段是否已注入等），并在协议里明确「未知就是未知」。
- 失效场景 1、2、4 无法靠信号解决，只能靠产品设计解决：输入条在 Prompt 之外的任何时候都不抢键；用户可一键切直通。
- 「猜测」与「确知」在 UI 上必须可区分（例如输入框前的状态点），否则用户永远不知道该不该相信输入条。
