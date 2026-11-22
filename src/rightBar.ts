// 功能栏（右栏）的纯逻辑：哪些面板可见、从上到下怎么排、谁吃掉剩余高度。
//
// 这里只处理数据，不碰 DOM、不读 localStorage；`rightBarUi.ts` 负责把结果搬到页面上。
// 三个面板完全同权（ADR 0007）：没有「永远撑满的文件栏」，最后一个展开的面板吃剩余高度。

export const RIGHT_PANELS = ["shortcuts", "ports", "files"] as const;
export type RightPanel = (typeof RIGHT_PANELS)[number];

export interface RightBarState {
  /// 三个面板的上下顺序。没勾选的面板也在里面——勾回来时位置不变。
  order: RightPanel[];
  /// 取消勾选的面板：不展示、不占高、不跑后台刷新。
  hidden: RightPanel[];
}

export const RIGHT_BAR_KEY = "pinshell.rightbar";
/// 功能栏结构变化后派发的事件。面板据此停/开自己的后台刷新。
export const RIGHT_BAR_EVENT = "pinshell:rightbar";

/// 默认顺序：两个选择器/小工具在上，文件树在下面撑满（ADR 0007）。
export const DEFAULT_RIGHT_ORDER: RightPanel[] = ["shortcuts", "ports", "files"];
export const DEFAULT_RIGHT_BAR: RightBarState = {
  order: [...DEFAULT_RIGHT_ORDER],
  hidden: []
};

/// 功能面板高度的下限，以及单个面板最多占功能栏可用高度的多少。
/// 与输入条、左栏的拖高手势共用同一套边界，别再各写一份。
export const MIN_PANEL_HEIGHT = 120;
export const MAX_PANEL_RATIO = 0.7;

/// 夹取一个功能面板的高度。`available` 是功能栏内容区的实时高度。
export function clampPanelHeight(value: number, available: number): number {
  const max = Math.max(MIN_PANEL_HEIGHT, Math.floor(available * MAX_PANEL_RATIO));
  const min = Math.min(MIN_PANEL_HEIGHT, max);
  const wanted = Number.isFinite(value) ? Math.round(value) : MIN_PANEL_HEIGHT;
  return Math.max(min, Math.min(wanted, max));
}

function isPanel(value: unknown): value is RightPanel {
  return typeof value === "string" && (RIGHT_PANELS as readonly string[]).includes(value);
}

/// 顺序表规整：认识的 id 按原顺序保留、去重；缺的按默认顺序补在后面。
/// 这样旧版本（只有两个面板）或写坏的数据都能读，且不会把用户排好的顺序打乱。
function normalizeOrder(raw: unknown): RightPanel[] {
  const seen = new Set<RightPanel>();
  const order: RightPanel[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPanel(item) || seen.has(item)) continue;
      seen.add(item);
      order.push(item);
    }
  }
  for (const id of DEFAULT_RIGHT_ORDER) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

function normalizeHidden(raw: unknown): RightPanel[] {
  if (!Array.isArray(raw)) return [];
  const hidden: RightPanel[] = [];
  for (const item of raw) {
    if (!isPanel(item) || hidden.includes(item)) continue;
    hidden.push(item);
  }
  return hidden;
}

/// 解析 localStorage 里的整份状态。任何拿不准的输入都退回默认值，
/// 存坏一格设置不该让功能栏消失。
export function parseRightBar(raw: unknown): RightBarState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { order: [...DEFAULT_RIGHT_ORDER], hidden: [] };
  }
  const source = raw as Partial<RightBarState>;
  return {
    order: normalizeOrder(source.order),
    hidden: normalizeHidden(source.hidden)
  };
}

export function serializeRightBar(state: RightBarState): string {
  return JSON.stringify({ order: state.order, hidden: state.hidden });
}

/// 上下移动一格。到头就原样返回（调用方据此判断要不要重画）。
export function movePanel(state: RightBarState, id: RightPanel, delta: -1 | 1): RightBarState {
  const index = state.order.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.order.length) return state;
  const order = [...state.order];
  [order[index], order[target]] = [order[target], order[index]];
  return { ...state, order };
}

/// 勾选/取消勾选。取消勾选不影响它在顺序表里的位置。
export function setPanelHidden(state: RightBarState, id: RightPanel, hidden: boolean): RightBarState {
  const has = state.hidden.includes(id);
  if (has === hidden) return state;
  return {
    ...state,
    hidden: hidden ? [...state.hidden, id] : state.hidden.filter((entry) => entry !== id)
  };
}

/// 当前正在展示的面板，按顺序排列。
export function visiblePanels(state: RightBarState): RightPanel[] {
  return state.order.filter((id) => !state.hidden.includes(id));
}

/// 谁吃剩余高度：顺序上最后一个**可见且展开**的面板；都收起了就没有人。
/// 折叠状态由各面板自己维护，这里只接收结果，不保存。
export function fillPanel(
  state: RightBarState,
  expanded: Partial<Record<RightPanel, boolean>>
): RightPanel | null {
  const visible = visiblePanels(state);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const id = visible[index];
    if (expanded[id]) return id;
  }
  return null;
}
