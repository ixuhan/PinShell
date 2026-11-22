/**
 * 指针事件拖拽的 DOM 部分：命中目标格、画边缘/中心高亮、松手回调。
 *
 * 刻意不用 HTML5 拖放：WebView2 下拖拽图像与 `preventDefault` 的行为不一致，
 * 而且我们只需要「按住标题条 → 移到某一侧 → 松手」这一条路径。
 */

import { hitZone, type DropZone } from "./layoutTree";
import { decideDrop, exceededDragThreshold } from "./paneDrag";

export interface PaneDragPayload {
  /// 拖的是哪一格
  session: string;
}

export interface PaneDropInfo {
  target: string;
  zone: DropZone;
  payload: PaneDragPayload;
}

export interface PaneDragHandlers {
  drop(info: PaneDropInfo): void;
  /// 越过拖动阈值、真正进入拖拽态（用来关掉可能还开着的菜单）
  activate?(): void;
  /// 回弹 / Esc / 拖到自己身上
  cancel?(): void;
}

const HIGHLIGHT = ["drop-left", "drop-right", "drop-top", "drop-bottom", "drop-center"];

function sectionAt(x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof Element)) return null;
  return element.closest<HTMLElement>(".term-pane[data-session]");
}

function zoneAt(section: HTMLElement, x: number, y: number): DropZone {
  const rect = section.getBoundingClientRect();
  return hitZone(
    { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    x,
    y
  );
}

function clearHighlight(pane: HTMLElement | null) {
  pane?.classList.remove(...HIGHLIGHT);
}

/**
 * 从一次 pointerdown 开始跟踪拖拽。调用方负责只让标题条发起（终端区域要留给选区）。
 * 没越过阈值就当普通点击，不拦截、不 preventDefault。
 */
export function beginPaneDrag(
  event: PointerEvent,
  payload: PaneDragPayload,
  handlers: PaneDragHandlers
): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let active = false;
  let hovered: HTMLElement | null = null;

  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("pane-drag-active");
    clearHighlight(hovered);
    hovered = null;
  };

  const move = (ev: PointerEvent) => {
    if (!active) {
      if (!exceededDragThreshold(startX, startY, ev.clientX, ev.clientY)) return;
      active = true;
      document.body.classList.add("pane-drag-active");
      handlers.activate?.();
    }
    const pane = sectionAt(ev.clientX, ev.clientY);
    if (pane !== hovered) {
      clearHighlight(hovered);
      hovered = pane;
    }
    if (!pane) return;
    const zone = zoneAt(pane, ev.clientX, ev.clientY);
    const target = pane.dataset.session ?? "";
    // 同一格、或落到自己身上：不画高亮，松手也不做任何改变
    if (decideDrop(zone, payload.session, target).action === "none") {
      clearHighlight(pane);
      return;
    }
    pane.classList.remove(...HIGHLIGHT);
    pane.classList.add(zone.kind === "center" ? "drop-center" : `drop-${zone.side}`);
  };

  const up = (ev: PointerEvent) => {
    const wasActive = active;
    const pane = wasActive ? sectionAt(ev.clientX, ev.clientY) : null;
    const target = pane?.dataset.session ?? "";
    const zone = pane ? zoneAt(pane, ev.clientX, ev.clientY) : null;
    cleanup();
    if (!wasActive || !pane || !zone) {
      handlers.cancel?.();
      return;
    }
    if (decideDrop(zone, payload.session, target).action === "none") {
      handlers.cancel?.();
      return;
    }
    handlers.drop({ target, zone, payload });
  };

  const cancel = () => {
    cleanup();
    handlers.cancel?.();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    }
  };

  // Alt+Tab / 点别的窗口：不取消的话高亮遮罩会一直留在屏幕上
  const onBlur = () => cancel();

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", onBlur);
  document.addEventListener("keydown", onKey, true);
}
