// 侧栏子面板的统一折叠：会话 / 串口 / 快捷指令 / 文件 四个子栏共用一套规则。
//
// 「单击子栏的标题栏就是折叠/展开」是这里唯一的交互，所以 `.collapsed` 类名、
// aria-expanded、箭头方向、悬停提示都只在这一处决定，别让四个子栏各写一遍再慢慢长歪。

import { t } from "./i18n";

/// 折叠状态挂在面板根元素上的类名；样式用它隐藏 `.panel-body`。
export const FOLD_CLASS = "collapsed";

/// 折叠时箭头指右、展开时指下。子栏收起来后「点它展开」的语义两边一致。
export function foldChevron(collapsed: boolean): string {
  return collapsed ? "▸" : "▾";
}

/// 标题栏的悬停提示：说清楚点下去会发生什么。
/// `label` 传已本地化的面板名（调用方用 `t("sidebar.sessions")` 这类键取）。
export function foldTitle(label: string, collapsed: boolean): string {
  return collapsed ? t("panel.expand", { label }) : t("panel.collapse", { label });
}

/// 从 localStorage 读回折叠状态。只认 `"1"` / `"0"`；
/// 其它值（没有记录、被写坏）按 `fallback` 走——默认展开，内容看得见比藏起来安全。
export function parseFolded(raw: string | null, fallback = false): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}

export function serializeFolded(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

/// 事件目标是不是一个不该触发折叠的东西。
/// 标题栏整条都能折叠，但点在这些东西上时不该顺带把面板收起来：
/// - 自带点击语义的控件（按钮、输入框、下拉、链接）；
/// - 标了 `data-fold-ignore` 的元素：高度拖拽手柄嵌在标题栏里，单击它只想调整高度。
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest("button, input, select, textarea, a, label, option") !== null ||
    target.closest("[data-fold-ignore]") !== null
  );
}

export interface FoldPanelOptions {
  /// 加/去 `.collapsed` 的元素：样式按它隐藏 `.panel-body`、收起固定高度
  root: HTMLElement;
  /// 标题按钮：单击折叠/展开，同时承载 aria-expanded
  toggle: HTMLElement;
  /// 标题前的箭头；没有就传 null
  chevron: HTMLElement | null;
  /// 面板名，用在提示文案里（「收起串口」/「展开串口」）
  label: string;
  collapsed: boolean;
  /// 状态真的变了才回调；调用方在这里写 localStorage、重排终端
  onChange(collapsed: boolean): void;
}

export interface FoldPanel {
  /// 外部改状态。`silent` 为 true 时只搬 DOM、不回调 onChange，
  /// 用于「切会话时换上另一套已保存的状态」这种被动同步。
  set(collapsed: boolean, silent?: boolean): void;
  readonly collapsed: boolean;
}

/// 把折叠状态搬到 DOM 上：类名、aria、箭头、提示四者永远一起变。
export function setupFoldPanel(options: FoldPanelOptions): FoldPanel {
  let collapsed = options.collapsed;

  function paint() {
    options.root.classList.toggle(FOLD_CLASS, collapsed);
    options.toggle.setAttribute("aria-expanded", String(!collapsed));
    options.toggle.title = foldTitle(options.label, collapsed);
    if (options.chevron) options.chevron.textContent = foldChevron(collapsed);
  }

  function set(next: boolean, silent = false) {
    if (next === collapsed) return;
    collapsed = next;
    paint();
    if (!silent) options.onChange(collapsed);
  }

  // 按钮不抢焦点：点完还能接着在终端里敲键盘
  options.toggle.addEventListener("mousedown", (event) => event.preventDefault());
  options.toggle.addEventListener("click", () => set(!collapsed));
  // 整条标题栏都是折叠开关：空白处、标题文字单击都算，只有控件自己处理点击
  options.toggle.parentElement?.addEventListener("click", (event) => {
    if (isInteractiveTarget(event.target)) return;
    set(!collapsed);
  });

  paint();
  return {
    set,
    get collapsed() {
      return collapsed;
    }
  };
}
