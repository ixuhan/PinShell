export function resetDialogPosition(dialog: HTMLElement): void {
  for (const property of ["position", "margin", "left", "top", "transform"]) {
    dialog.style.removeProperty(property);
  }
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
      const maxLeft = Math.max(0, window.innerWidth - dialog.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - dialog.offsetHeight);
      const left = Math.max(0, Math.min(maxLeft, moveEvent.clientX - offsetX));
      const top = Math.max(0, Math.min(maxTop, moveEvent.clientY - offsetY));
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
