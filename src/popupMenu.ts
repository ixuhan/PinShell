// 全应用共用的弹出菜单。
//
// 会话操作、新建会话类型、排序方式、文件面板的降级右键菜单都走这一份，
// 所以字体、间距、边框、键盘操作只有一套：等宽 12px，和侧栏会话行同一套字。
// 菜单挂在 body 上，不继承任何面板的字号——不显式写就会退回 WebView2 的默认
// 衬线字体，和主界面完全两样。
//
// 菜单不抢焦点：按下鼠标就 preventDefault，只有「点外面 / Esc / 选中一项」才关，
// 所以从终端里右键弹菜单时焦点仍留在终端上。

import { clampMenuPosition } from "./filePanel";

export interface PopupItem {
  label: string;
  /// 悬停提示（做不进标签里的说明，比如「切换到接管输入」）
  title?: string;
  /// 右侧灰字说明（可选）
  hint?: string;
  /// 前面打勾：排序方式这类「当前值」
  checked?: boolean;
  disabled?: boolean;
  /// 危险操作：整行用告警红（删除会话）
  danger?: boolean;
  /// 点中后执行。返回 `"keep-open"` 时菜单留着——二次确认要停在原地。
  run?: () => void | "keep-open";
}

export interface PopupMenuHandle {
  close(): void;
  /// 项的文字/禁用状态变了之后重画（异步查到状态、二次确认换文案）
  repaint(): void;
  readonly element: HTMLDivElement;
}

/// 锚点：鼠标坐标（右键）或者某个元素（工具栏按钮下方弹出）。
export type MenuAnchor = { x: number; y: number } | HTMLElement;

interface OpenMenu {
  handle: PopupMenuHandle;
  dispose(): void;
}

let open: OpenMenu | null = null;

export function isPopupMenuOpen(): boolean {
  return open !== null;
}

export function closePopupMenu(): void {
  open?.handle.close();
}

export function showPopupMenu(
  anchor: MenuAnchor,
  items: PopupItem[],
  options: { minWidth?: number } = {}
): PopupMenuHandle {
  closePopupMenu();

  const element = document.createElement("div");
  element.className = "popup-menu";
  element.setAttribute("role", "menu");
  if (options.minWidth) element.style.minWidth = `${options.minWidth}px`;
  // 定位前先藏起来：先按 0,0 量尺寸，量完再摆，别让它在左上角闪一帧
  element.style.visibility = "hidden";
  document.body.append(element);

  // 有勾选项时整列都留出勾的位置，文字才不会一边齐一边不齐
  const checks = items.some((item) => item.checked !== undefined);
  const rows: HTMLButtonElement[] = [];
  const labels: HTMLSpanElement[] = [];
  const marks: HTMLSpanElement[] = [];
  const hints: HTMLSpanElement[] = [];
  let index = -1;

  items.forEach((item, position) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "popup-item";
    row.setAttribute("role", "menuitem");
    const mark = document.createElement("span");
    mark.className = "popup-check";
    const label = document.createElement("span");
    label.className = "popup-label";
    const hint = document.createElement("span");
    hint.className = "popup-hint";
    if (checks) row.append(mark);
    row.append(label, hint);
    // 点菜单不该把焦点从终端/输入条抢走
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("pointerenter", () => setIndex(position));
    row.addEventListener("click", () => activate(position));
    element.append(row);
    rows.push(row);
    labels.push(label);
    marks.push(mark);
    hints.push(hint);
  });

  function sync() {
    items.forEach((item, position) => {
      const row = rows[position];
      row.classList.toggle("danger", !!item.danger);
      row.disabled = !!item.disabled;
      row.title = item.title ?? "";
      labels[position].textContent = item.label;
      marks[position].textContent = item.checked ? "✓" : "";
      const hint = hints[position];
      hint.textContent = item.hint ?? "";
      hint.hidden = !item.hint;
    });
  }

  function setIndex(next: number) {
    if (!rows.length) return;
    const moved = ((next % rows.length) + rows.length) % rows.length;
    index = moved;
    rows.forEach((row, position) => row.classList.toggle("sel", position === moved));
  }

  function step(direction: 1 | -1) {
    // 跳过禁用项：一直按 ↓ 不能停在灰掉的那一行上
    for (let taken = 1; taken <= rows.length; taken++) {
      const candidate = (((index + direction * taken) % rows.length) + rows.length) % rows.length;
      if (!rows[candidate].disabled) {
        setIndex(candidate);
        return;
      }
    }
  }

  /// 打开时把高亮放在第一个可用项上，随后按 Enter 就能直接执行。
  function focusInitial() {
    const first = rows.findIndex((row) => !row.disabled);
    if (first < 0) {
      index = -1;
      return;
    }
    setIndex(first);
  }

  function activate(position: number) {
    const item = items[position];
    if (!item || item.disabled) return;
    const outcome = item.run?.();
    if (outcome !== "keep-open") close();
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      activate(index);
    } else if (event.key === "Tab") {
      close();
    }
  };
  const onDismiss = () => close();
  // 菜单打开期间，键盘事件在捕获阶段截住：焦点可能还在终端里
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("scroll", onDismiss, true);
  window.addEventListener("blur", onDismiss);
  window.addEventListener("resize", onDismiss);

  function dispose() {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("scroll", onDismiss, true);
    window.removeEventListener("blur", onDismiss);
    window.removeEventListener("resize", onDismiss);
    element.remove();
  }

  function close() {
    if (open?.handle !== handle) return;
    open = null;
    dispose();
  }

  const handle: PopupMenuHandle = {
    close,
    repaint: sync,
    element
  };

  sync();
  // 先渲染再量尺寸：贴到视口右下角时要往回收，量 0×0 会把它顶到角外
  const rect = element.getBoundingClientRect();
  const spot =
    anchor instanceof HTMLElement
      ? clampMenuPosition(
          anchor.getBoundingClientRect().left,
          anchor.getBoundingClientRect().bottom + 4,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight
        )
      : clampMenuPosition(anchor.x, anchor.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
  element.style.left = `${spot.x}px`;
  element.style.top = `${spot.y}px`;
  element.style.visibility = "";
  open = { handle, dispose };
  focusInitial();

  return handle;
}
