// 写进 PTY 之前要摘掉的东西。
//
// xterm.js 的 onData 里混着两类字节：用户真按下的键，和「终端对 Shell 的回报」。
// 回报里光标位置应答（`ESC[n;mR` 一类）必须原样转给 Shell —— 那是应答；而焦点进入/离开
// （DECSET 1004 的 `ESC[I` / `ESC[O`）只是终端在说「窗口有/没焦点」，不是用户输入。
// 把它当按键写进去，PSReadLine 会当成输入处理：响一声、还可能把整屏重画一遍。
//
// 所以只摘这两种，别的都留着。

const FOCUS_REPORT = /\x1b\[[IO]/g;

/// 摘掉焦点进入/离开报告（`ESC[I` / `ESC[O`），其余字节原样返回。
export function stripFocusReports(data: string): string {
  return data.replace(FOCUS_REPORT, "");
}
