// 终端的固定渲染参数。
//
// 字号不在这里：它跟着会话走（会话设置里改），存在工作区的 `SessionSettings` 里。
// 字体、光标闪烁、WebGL 曾经是全局设置里的开关，现在界面不再暴露它们，
// 于是收敛成这里的常量——不再有 localStorage 读写，也不会因为存坏了而改变行为。

/// 终端字体。等宽字体优先，找不到时回退到系统自带的三档。
export const TERMINAL_FONT_FAMILY = '"Cascadia Mono", Consolas, "Courier New", monospace';

/// 光标是否闪烁。终端里光标闪烁更容易找到焦点，保持开启。
export const TERMINAL_CURSOR_BLINK = true;

/// 是否尝试 WebGL 渲染。失败时 `applyWebgl` 会自动退回 DOM 渲染器。
export const TERMINAL_WEBGL = true;

/// 会话没有设置过字号时的默认值（与 core-domain 的 `DEFAULT_FONT_SIZE` 一致）。
export const DEFAULT_FONT_SIZE = 13;

/// 字号的可选区间（与 core-domain 的 `MIN_FONT_SIZE` / `MAX_FONT_SIZE` 一致）。
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;

/// 把任意输入收敛成一个可用的字号：非整数、越界都夹回合法区间。
export function clampFontSize(value: unknown): number {
  const size = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}
