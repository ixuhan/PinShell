// 功能栏（右栏）的装配：把 `rightBar.ts` 的状态搬到 DOM 上。
//
// 只做三件事：隐藏没勾选的面板、按顺序重排、把 `rb-fill` 发给最后一个展开的面板。
// 面板自己的高度、折叠、列表渲染仍归各自的模块；这里不碰它们的状态。
// 每次真正变化后广播 `pinshell:rightbar`，文件面板与串口列表据此停/开后台刷新。

import {
  RIGHT_BAR_KEY,
  RIGHT_BAR_EVENT,
  RIGHT_PANELS,
  fillPanel,
  movePanel,
  parseRightBar,
  serializeRightBar,
  setPanelHidden,
  visiblePanels,
  type RightBarState,
  type RightPanel
} from "./rightBar";

/// 全部面板都不展示时挂到 #files 上的类：整条功能栏消失（样式里 display: none）。
export const NO_PANELS_CLASS = "no-panels";
/// 单个面板吃掉剩余高度时挂到它自己身上的类。
export const FILL_CLASS = "rb-fill";

export interface RightBarDeps {
  /// 列宽/可见性变了：让终端重新 fit 一次
  layoutChanged(): void;
}

export interface RightBarHandle {
  state(): RightBarState;
  /// 勾选/取消勾选一个面板（即时生效）
  setVisible(id: RightPanel, visible: boolean): void;
  /// 上下移动一格（即时生效）
  move(id: RightPanel, delta: -1 | 1): void;
}

const PANEL_ELEMENT_ID: Record<RightPanel, string> = {
  shortcuts: "shortcuts-panel",
  ports: "ports-panel",
  files: "files-panel"
};

function loadStored(): RightBarState {
  try {
    const raw = localStorage.getItem(RIGHT_BAR_KEY);
    return parseRightBar(raw ? JSON.parse(raw) : null);
  } catch {
    return parseRightBar(null);
  }
}

/// 拖高某个面板时它最多能长到哪里：功能栏的可用高度，减去其它**可见、展开、非填充**面板
/// 已经占掉的高度。多出来的空间属于吃剩余高度的那一个；否则三个面板各按 70% 夹取，
/// 加起来可以把最后一块挤到负高度、从栏底溢出去。
export function panelColumnBudget(panel: HTMLElement): { available: number; room: number } {
  const body = panel.parentElement;
  const measured = body ? body.getBoundingClientRect().height : 0;
  const available = measured > 0 ? measured : window.innerHeight;
  let others = 0;
  if (body) {
    for (const child of body.children) {
      if (!(child instanceof HTMLElement) || child === panel) continue;
      if (child.hidden || child.classList.contains("collapsed") || child.classList.contains(FILL_CLASS)) {
        continue;
      }
      others += child.getBoundingClientRect().height;
    }
  }
  return { available, room: Math.max(0, available - others) };
}

export function setupRightBar(deps: RightBarDeps): RightBarHandle {
  const column = document.getElementById("files") as HTMLElement;
  const body = document.getElementById("files-body") as HTMLElement;
  const barToggle = document.getElementById("bar-toggle-right") as HTMLButtonElement | null;
  const panels = {} as Record<RightPanel, HTMLElement>;
  for (const id of RIGHT_PANELS) {
    panels[id] = document.getElementById(PANEL_ELEMENT_ID[id]) as HTMLElement;
  }
  let state = loadStored();

  function save() {
    try {
      localStorage.setItem(RIGHT_BAR_KEY, serializeRightBar(state));
    } catch {
      // 存不下只影响下次打开的默认值
    }
  }

  /// 展开 = 面板根元素上没有 `.collapsed`（panelFold 维护）。
  function expandedOf(id: RightPanel): boolean {
    return !panels[id].classList.contains("collapsed");
  }

  /// 顺序真的不一样时才搬 DOM，避免每次设置变化都把三棵子树挪一遍。
  function applyOrder() {
    const current = [...body.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("panel"))
      .map((element) => (Object.entries(PANEL_ELEMENT_ID) as [RightPanel, string][])
        .find(([, elementId]) => elementId === element.id)?.[0])
      .filter((id): id is RightPanel => !!id);
    if (current.length === state.order.length && current.every((id, index) => id === state.order[index])) {
      return;
    }
    for (const id of state.order) body.append(panels[id]);
  }

  /// 只重算「谁吃剩余高度」。折叠状态变化走这里，不触发 terminal fit——
  /// 折叠不改主区尺寸，面板自己已经调过 layoutChanged。
  function applyFill() {
    const expanded = {} as Partial<Record<RightPanel, boolean>>;
    for (const id of RIGHT_PANELS) expanded[id] = expandedOf(id);
    const fill = fillPanel(state, expanded);
    for (const id of RIGHT_PANELS) {
      panels[id].classList.toggle(FILL_CLASS, id === fill);
    }
  }

  function notify() {
    document.dispatchEvent(new Event(RIGHT_BAR_EVENT));
  }

  function paint(relayout = true) {
    const visible = visiblePanels(state);
    for (const id of RIGHT_PANELS) panels[id].hidden = !visible.includes(id);
    applyOrder();
    applyFill();
    const empty = visible.length === 0;
    column.classList.toggle(NO_PANELS_CLASS, empty);
    if (barToggle) barToggle.disabled = empty;
    save();
    if (!relayout) return;
    deps.layoutChanged();
    notify();
  }

  // 折叠只影响「谁吃剩余高度」：面板自己的 setupFoldPanel 会改根元素的类名，
  // 这里观察到之后重算一次即可，不重复派发事件（折叠由面板自己负责重排）。
  const observer = new MutationObserver(() => applyFill());
  for (const id of RIGHT_PANELS) {
    observer.observe(panels[id], { attributes: true, attributeFilter: ["class"] });
  }

  // 首屏只把可见性/顺序/填充搬到 DOM 上：此刻 main.ts 还没走到 `syncSize` 的后置声明，
  // 各面板也还没装配完。终端尺寸由它们的初始化与 ResizeObserver 统一负责。
  paint(false);

  return {
    state() {
      return { order: [...state.order], hidden: [...state.hidden] };
    },
    setVisible(id, visible) {
      const next = setPanelHidden(state, id, !visible);
      if (next === state) return;
      state = next;
      paint();
    },
    move(id, delta) {
      const next = movePanel(state, id, delta);
      if (next === state) return;
      state = next;
      paint();
    }
  };
}
