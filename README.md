# PinShell

轻量、快速、内存占用小的 Windows 终端。单进程、单主窗口、便携优先，基于 Tauri 2 + xterm.js + Rust (ConPTY)。

> 目标：不追求做成"另一个大而全终端"，聚焦轻量边界下的全功能：快速、内存小、占用少、便携。

## ✨ 功能简介

**终端核心**
- ConPTY 原生会话，xterm.js 渲染（WebGL 加速）
- 多会话 / 分格工作区，会话栏可拖宽、可收起
- 自定义标题栏、深色主题、无边框窗口

**智能输入条**
- 命令历史库，持久化到本地
- Ghost Text 前缀预测（带字体度量缓存与前缀索引，打字路径零卡顿）
- `Ctrl+R` 历史搜索
- 暂停清屏、命令片段

**会话恢复**
- 卷轴快照：关闭重开还原到原样
- 页面重载自动挂回会话，不杀进程
- 会话重命名

**Shell 集成**
- OSC 133 命令标记，精准识别"可输入时刻"
- 集成脚本（PowerShell / Bash）注入提示符、目录、退出码上报
- 原生右键菜单（helper 进程实现，无 DLL 注入）

**文件面板**
- 跟随会话 CWD 或固定路径
- 自动刷新、可拖宽、「..」回退
- 按会话的显示设置

**串口支持**
- 串口通道（与终端同一套 Transport 抽象）
- 端口枚举、HEX 显示、串口日志

**工程可靠性**
- 运行日志 500ms 定期落盘，写路径不逐块刷盘
- 失败路径 RAII 清理，杜绝孤儿 shell 进程
- OSC/CSI 解析带 64KB 上限与安全 reset，恶意序列不会卡死解析器

## 📦 下载安装

前往 [Releases](https://github.com/ixuhan/PinShell/releases) 下载：

| 文件 | 说明 |
|---|---|
| `PinShell_x.y.z_x64-setup.exe` | Windows 安装包（NSIS，推荐） |
| `PinShell_x.y.z_x64_en-US.msi` | Windows MSI 安装包 |

系统要求：Windows 10/11 x64（依赖 WebView2，Windows 11 已内置）。

## 🚀 从源码构建

```bash
# 依赖：Node.js 18+、Rust (MSVC)、WebView2
npm install

# 开发模式
npm run app:dev

# 构建 Windows 安装包（NSIS + MSI）
npm run app:build
```

## 🏗️ 架构

单进程设计：WebView2 前端 + Rust 主进程（多线程），IPC 事件流通信。

- `core-domain`：纯领域模型 crate（无 IO），可独立测试
- `transport`：ConPTY / 串口统一抽象
- `session-runtime`：会话生命周期、卷轴快照、重放缓冲
- `integration`：OSC 集成脚本注入
- `input-engine`：命令历史与 Ghost Text 预测
- `persistence`：配置、工作区、历史库（原子写 + 便携目录）
- `panels`：文件面板、串口枚举、右键菜单 helper

详见 [架构文档](docs/architecture.md) 与 [ADR 决策记录](docs/adr/)。

## 📄 License

<!-- TODO: 选定许可证后补充（建议 MIT），并添加 LICENSE 文件 -->
暂未确定
