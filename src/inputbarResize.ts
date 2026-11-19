// 输入区上沿的纵向分隔拖动。高度只在松手时写入偏好并触发终端重排。

import { DRAGGING_CLASS } from "./resize";

const STORE_KEY = "pinshell.inputbar.height";
const DEFAULT_HEIGHT = 156;
const MIN_HEIGHT = 90;
const MAX_HEIGHT_RATIO = 0.55;

export interface InputbarResizeDeps {
  layoutChanged(): void;
}

function clampHeight(value: number): number {
  const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
  return Math.max(MIN_HEIGHT, Math.min(Math.round(value), max));
}

export function setupInputbarResize(deps: InputbarResizeDeps): void {
  const main = document.getElementById("main") as HTMLElement;
  const handle = document.getElementById("inputbar-resizer") as HTMLElement;

  const storedHeight = Number(localStorage.getItem(STORE_KEY));
  let height = storedHeight >= MIN_HEIGHT ? clampHeight(storedHeight) : clampHeight(DEFAULT_HEIGHT);
  const applyHeight = () => main.style.setProperty("--inputbar-height", `${height}px`);
  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, String(height));
    } catch {
      // The current window keeps the chosen size even when storage is unavailable.
    }
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let moved = false;

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners below still track the drag if capture is unavailable.
    }

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampHeight(startHeight + startY - moveEvent.clientY);
      if (next === height) return;
      height = next;
      moved = true;
      applyHeight();
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      document.body.classList.remove(DRAGGING_CLASS);
      if (moved) {
        save();
        deps.layoutChanged();
      }
    };

    document.body.classList.add(DRAGGING_CLASS);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  });

  handle.addEventListener("dblclick", () => {
    height = clampHeight(DEFAULT_HEIGHT);
    applyHeight();
    save();
    deps.layoutChanged();
  });

  window.addEventListener("resize", () => {
    const next = clampHeight(height);
    if (next === height) return;
    height = next;
    applyHeight();
    save();
    deps.layoutChanged();
  });

  applyHeight();
}
