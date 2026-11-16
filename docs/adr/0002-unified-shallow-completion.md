# 0002 补全只做「统一浅补全」，不做原生补全对等

- 状态：已接受（2026-11-16）
- 相关：需求「输入层从 Shell 抽出来」；调研二

## 背景

输入条接管行编辑的那一刻，就同时放弃了 PSReadLine 的参数补全、bash-completion 的动态补全、Clink 的 Lua 补全——它们都跑在 Shell 进程内，依赖 Shell 的行编辑缓冲。

两条路：

- **A 统一浅补全**：历史前缀 + 路径 + 每 shell 静态命令表。四种 shell 行为完全一致。
- **B 原生补全对等**：为每种 shell 做同步补全查询通道（PowerShell 可导出 cmdlet/参数；bash 需要把 `compgen` 请求回灌到 Shell）。复杂度高一个量级，WSL 与 cmd 基本无解，且每次 <TAB> 都要跨进程往返。

## 决策

选 A。补全来源固定为三源合成：**本会话历史**、**文件路径**、**每 shell 一份静态命令/别名表**（PowerShell 可导出已加载 cmdlet 名，bash/zsh 读各自别名，cmd 读 doskey 宏）。

后端保留 `CompletionProvider` 接口，为将来只给 PowerShell 接一条原生通道留口子，但**不在第一版实现**。

## 后果

- 用户会感知到 `git checkout <TAB>` 不如 Windows Terminal 好用。这是自觉的取舍，不是 bug——必须在设置页与文档里写清楚，避免被当成缺陷反复报。
- 补全结果可预测、可跨 shell 一致，这正是「统一体验」卖点的一部分。
- 静态命令表需要随版本更新（pwsh 模块命令变化），走「检测到差异则后台重建」而不是每次启动重建。

## 替代方案

- 直接不做补全，只留历史与 Ghost Text：更省，但输入条会显得比 Tabby/Clink 更弱。
- 做 B：会让 M1 的工期翻倍，并让 cmd 永远残缺。
