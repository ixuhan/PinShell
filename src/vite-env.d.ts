/// Vite 注入的类型（`import.meta.env`）。只放这一行，避免把整个类型包塞进 tsconfig。
/// 打包判定必须用它，不能用 `location.protocol`：Tauri 2 在 Windows 上的自定义协议
/// 默认是 `http://tauri.localhost`，打包版的 protocol 同样是 `http:`。
/// <reference types="vite/client" />
