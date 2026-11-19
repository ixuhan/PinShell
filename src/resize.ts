// 左右两栏共用的「拖分隔边改宽度」手势。
//
// 拖动期间只把新宽度写进 CSS，不碰任何重排；松手才让调用方做一次昂贵的事
// （重排终端、写 localStorage）。两侧的合法区间各自由调用方提供，这里只负责手势。

/// 布局拖动期间挂在 body 上的类：样式用它换光标，main.ts 靠它把终端重排推迟到松手。
export const DRAGGING_CLASS = "layout-dragging";

export interface DragWidthOptions {
  /// 分隔条相对被调栏的位置："right" 表示分隔条贴在右边缘，往右拖是加宽
  edge: "left" | "right";
  /// 被调栏开始拖动时的宽度
  startWidth: number;
  /// 合法区间，拖动中每帧都会调用一次
  clamp: (desired: number) => number;
  /// 宽度变了：调用方只改 CSS
  onWidth: (width: number) => void;
  /// 松手：`moved` 为 false 表示只是点了一下，调用方不该写配置、也不该重排
  onEnd: (width: number, moved: boolean) => void;
}

/// 从 `pointerdown` 开始接管一次拖动，直到 pointerup / pointercancel / 窗口失焦。
///
/// 监听器挂在 window 而不是手柄上：指针捕获在部分环境里会失败（抛 NotFoundError），
/// 一旦抛在 addEventListener 之前，整个手势就永远收不到 pointermove。
export interface DragHeightOptions {
  /// 分隔条贴在容器边缘：顶部向上拖增高，底部向下拖增高
  edge?: "top" | "bottom";
  startHeight: number;
  clamp: (desired: number) => number;
  onHeight: (height: number) => void;
  onEnd: (height: number, moved: boolean) => void;
}

/// 从 `pointerdown` 开始接管一次横向拖动，直到 pointerup / pointercancel / 窗口失焦。
export function dragWidth(event: PointerEvent, handle: HTMLElement, options: DragWidthOptions): void {
  const startX = event.clientX;
  let width = options.startWidth;
  let moved = false;

  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // 捕获失败不要紧：window 监听照样收得到移动。
  }

  const onMove = (moveEvent: PointerEvent) => {
    const delta = options.edge === "right" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
    const next = options.clamp(options.startWidth + delta);
    if (next === width) return;
    width = next;
    moved = true;
    options.onWidth(next);
  };

  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.body.classList.remove(DRAGGING_CLASS);
    options.onEnd(width, moved);
  };

  document.body.classList.add(DRAGGING_CLASS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
}

/// 从顶部的 pointerdown 接管一次纵向拖动，直到 pointerup / pointercancel / 窗口失焦。
export function dragHeight(
  event: PointerEvent,
  handle: HTMLElement,
  options: DragHeightOptions
): void {
  const startY = event.clientY;
  let height = options.startHeight;
  let moved = false;

  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // 捕获失败不要紧：window 监听仍然可以接收移动事件。
  }

  const onMove = (moveEvent: PointerEvent) => {
    const delta = moveEvent.clientY - startY;
    const next = options.clamp(options.startHeight + (options.edge === "bottom" ? delta : -delta));
    if (next === height) return;
    height = next;
    moved = true;
    options.onHeight(next);
  };

  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.body.classList.remove(DRAGGING_CLASS);
    options.onEnd(height, moved);
  };

  document.body.classList.add(DRAGGING_CLASS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
}
