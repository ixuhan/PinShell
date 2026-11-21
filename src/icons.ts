// 界面线性图标（行内按钮）：会话行的「⋯」与快捷指令行的「↑ ↓ ✎ ×」。
//
// 这些位置原来放的是字符（`⋯` `↑` `✎` `×`）。同一个字号下它们的视觉重量差很远：
// `✎`（U+270E）在多数字体里是实心笔身，比 `↑` 重一大截；`×` 又细得发飘；
// 四个并排看就像随手贴上去的符号，而不是一组控件。
//
// 统一规格：16 viewBox、1.35 描边、`currentColor`、圆头圆角，尺寸由 CSS 定（14px）。
// 颜色靠 `currentColor` 继承按钮文字色，切主题不用管。
//
// 注意：面板头部「批量选择」开关的 SVG 内联在 index.html（静态 HTML 没法 import TS），
// 规格与此处一致；改描边或 viewBox 时两处一起改，别又分叉成两套。

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;

export const ROW_ICON = {
  /// 更多：三个圆点用零长度线段 + 圆头画，描边参数和箭头、叉共用一套
  more: svg('<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.2" stroke-linecap="round" />'),
  up: svg('<path d="M8 13V3.5M3.8 7.7L8 3.5l4.2 4.2" />'),
  down: svg('<path d="M8 3v9.5M3.8 8.3L8 12.5l4.2-4.2" />'),
  edit: svg('<path d="M11.5 2.5l2 2M3 13l1-3.6 7.2-7.2 2.4 2.4-7.2 7.2L3 13z" />'),
  remove: svg('<path d="M4 4l8 8M12 4l-8 8" />')
};
