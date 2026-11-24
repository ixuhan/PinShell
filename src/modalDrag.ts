export function resetDialogPosition(dialog: HTMLElement): void {
  for (const property of ["position", "margin", "left", "top", "transform"]) {
    dialog.style.removeProperty(property);
  }
}

/// 标题栏是自绘的、永远压在弹窗上面（见 styles.css 的 --titlebar-height / #titlebar z-index），
/// 所以弹窗最多只能拖到标题栏下沿：再往上拖，抓手就被标题栏盖住，拖不回来了。
function dragFloor(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--titlebar-height");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 32;
}

export function enableDialogDrag(handle: HTMLElement, dialog: HTMLElement): void {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input, select, textarea, a")) return;
    event.preventDefault();

    const rect = dialog.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    dialog.style.position = "fixed";
    dialog.style.margin = "0";
    dialog.style.left = `${rect.left}px`;
    dialog.style.top = `${rect.top}px`;
    dialog.style.transform = "none";

    const onMove = (moveEvent: PointerEvent) => {
      const minTop = dragFloor();
      const maxLeft = Math.max(0, window.innerWidth - dialog.offsetWidth);
      const maxTop = Math.max(minTop, window.innerHeight - dialog.offsetHeight);
      const left = Math.max(0, Math.min(maxLeft, moveEvent.clientX - offsetX));
      const top = Math.max(minTop, Math.min(maxTop, moveEvent.clientY - offsetY));
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };

    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners still track the drag. */ }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  });
}
