//! PinShell 的核心领域：纯数据与规则，无 IO、无平台、无 Tauri 依赖。
//!
//! 这里的每个模块都必须满足两条：
//! 1. 只吃内存里的数据，不碰文件、进程、时钟（时间以参数传入）；
//! 2. 对外接口能被单元测试直接驱动，不需要拉起真实的 PTY。

pub mod osc;
pub mod ownership;
pub mod utf8_stream;
