# 调研二：框架与底层库

> 调研时间 2026-11。版本号以当时最新为准，落地时需复核。

## 外壳框架对比

| 方案 | 安装包 | 空载内存 | 终端渲染 | 原生 API | 风险 |
|---|---|---|---|---|---|
| Tauri 2.x | 3–10MB（复用系统 WebView2） | 约 40–45MB【推断，仅 macOS 二手实测】 | WebView2 + xterm.js | Rust 直调 Win32/COM，强 | 依赖 WebView2 存在 |
| Electron 45.x | ~90MB 安装 / 250MB 落盘 | ~140MB 空窗口【推断】 | 最好 | Node 原生插件 | 与「轻量」定位冲突 |
| Wails v3 | 数 MB + WebView2 | 无数据 | 同 Tauri | Go syscall/cgo | v3 刚稳定 |
| .NET + WPF/WinUI3 + WebView2 | 自包含 60MB+ | 无数据 | WebView2 或自绘 | 最全（COM/PInvoke 一等公民） | 包体与自包含分发 |
| Avalonia / Qt6 | 30–40MB+ | 无数据 | 无成品终端控件 | P/Invoke / 原生 | 终端要自绘 |
| egui / iced / slint | 5–15MB | 最低 | 全自绘 | Rust 直调 | 文本栅格化/IME/选区全自建 |

**结论**：轻量 + 快 + 内存小这三条，只有 Tauri 与 Rust 原生 UI 能满足；而 Rust 原生 UI 要自建终端渲染，工期以月计。**Tauri 2 + xterm.js 是当前唯一合理解**，代价是依赖 WebView2 运行时（可用 embedBootstrapper 约 +1.8MB 兜底）。

## 终端渲染

- **xterm.js 6.x**：据发布说明已移除 canvas 渲染器，只剩 DOM 与 WebGL。DOM 渲染在 5.3 之后大幅提速，WebGL 适合高刷新/大吞吐。本项目「可选 WebGL」的设想与此吻合。
- 需要的 API 都已具备：`buffer.active` 读行、`buffer.onBufferChange` 感知备用屏切换、`@xterm/addon-serialize` 导出 ANSI 快照（正好对应我们的「卷轴快照」）。
- 自绘方案（WT 的 AtlasEngine、Alacritty 的 OpenGL）能根治 ConPTY 重绘与输入法问题，但首版不做。

## PTY

- **ConPTY 官方要点**：两对管道 → `CreatePseudoConsole` → `STARTUPINFOEX` 带 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 启动进程；每个通道要有独立读取线程（否则死锁）；`ClosePseudoConsole` 会结束整棵子进程树；`ResizePseudoConsole` 只改字符尺寸、**不重排**已输出内容。
- ConPTY 不保证把备用屏语义「翻译」好，`?1049h/l` 的处理是终端侧责任——这就是我们必须自己维护备用屏状态的原因。
- 库：`portable-pty`（封装省事、维护慢）、`node-pty`（Electron 生态，不适用）、直接调 `CreatePseudoConsole`（控制力最强，自己做 UTF-8 跨块解码）。建议先用 `portable-pty` 打通，再按需下沉。
- WSL 与 Git Bash 都能在 ConPTY 下跑；Git Bash 没有 mintty 的 tty 语义，Ctrl+C 走控制台事件而非信号透传，需要单独回归。

## 串口

- `serialport` crate 的 `available_ports()` 直接返回 `UsbPort/PciPort/BluetoothPort/Unknown`，并带 VID/PID/厂商串——「USB/PCI/BT 标签」是现成的。
- Windows 串口独占：第二次打开返回 `ERROR_ACCESS_DENIED`；「暂停即释放」就是关闭句柄。
- `write_data_terminal_ready()` / `write_request_to_send()` 控制 DTR/RTS；HEX 只是视图层，与驱动能力无关。
- 枚举细节（含设备描述）再叠加 SetupAPI：`SetupDiGetClassDevs(&GUID_DEVCLASS_PORTS)` + `SPDRP_FRIENDLYNAME`。

## 原生集成

- Shell 右键菜单：`SHParseDisplayName` → `SHBindToParent` → `IShellFolder::GetUIObjectOf(IID_IContextMenu)` → `QueryContextMenu` → `TrackPopupMenuEx(TPM_RETURNCMD)` → `InvokeCommand`。必须在 **STA 线程且有消息泵**。
- 已知坑：32 位 shell 扩展在 64 位宿主里不显示；第三方扩展是 DLL 注入，崩了会带走宿主 → 建议放**独立 helper 进程**，失败降级为自建菜单。
- 保留设备名：`CON/PRN/AUX/NUL/COM1–9/LPT1–9` 及其带扩展名形式在任何目录都是设备；`COM10+` 需 `\\.\COM10`；访问同名普通文件要 `\\?\` 前缀。

## 持久化

- SQLite（WAL）适合「多会话 + 高频写 + 将来要检索」；缺点是多两个 `-wal/-shm` 文件，且 WAL 在网络盘/同步盘上可能不可用（便携目录被放进 OneDrive 时要探测并回退）。
- 原子替换的正确姿势：同目录同卷写 tmp → `FlushFileBuffers` → `MoveFileExW(tmp, dst, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`。Windows **没有目录 fsync**，别照搬 POSIX 写法。
- 目标文件被无 `FILE_SHARE_DELETE` 的句柄占用时替换会失败 → 需要退避重试（杀软/索引器常见）。

## 推荐组合

**Tauri 2 + xterm.js 6（DOM 默认，WebGL 可选）+ Rust 侧 ConPTY（先 portable-pty）+ serialport + rusqlite(WAL) 存历史 + JSON 存设置与工作区 + Tauri updater 的 minisign 验签。**

放弃：Electron 的 node-pty 生态、绝对单文件（WebView2 与资源目录会打破）、跨平台一致性。

## 风险清单

| 风险 | 触发条件 | 退路 |
|---|---|---|
| WebView2 缺失 | 精简版 Win10 / 企业镜像卸载 | embedBootstrapper（+1.8MB）；极端情况 fixedRuntime（+180MB） |
| 无 WebGL | 老 GPU、远程桌面 | 回落 DOM 渲染 |
| ConPTY 重绘/备用屏异常 | vim/htop、窗口 resize | 终端侧重绘兜底；根治要自绘 |
| 串口被占用 | 厂商工具没关 | 明确报错 + 重试，不静默重开 |
| shell 扩展崩溃 | 第三方 x86 扩展 | helper 进程隔离 + 降级菜单 |
| MoveFileEx 失败 | 杀软持有句柄 | 退避重试，tmp 名带 pid |
| WAL 不可用 | 便携目录在同步盘上 | 探测后回落 DELETE 模式或纯 JSON |
