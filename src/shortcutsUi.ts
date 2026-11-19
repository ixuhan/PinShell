import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { dragHeight } from "./resize";
import { clampShortcutHeight, DEFAULT_SHORTCUT_HEIGHT, moveShortcut, parseShortcutExport, type SessionShortcutPrefs, type Shortcut, type ShortcutMode } from "./shortcuts";

const STORE_KEY = "pinshell.shortcuts";
export interface ShortcutsUiDeps { sessionId(): string; fill(command: string): void; execute(command: string): Promise<void>; layoutChanged(): void; }
interface Store { defaults: { collapsed: boolean }; sessions: Record<string, SessionShortcutPrefs>; }

function readStore(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Partial<Store> | null;
    const sessions: Store["sessions"] = {};
    for (const [id, value] of Object.entries(raw?.sessions ?? {})) {
      if (!value || typeof value !== "object") continue;
      sessions[id] = {
        height: typeof value.height === "number" && Number.isFinite(value.height) ? value.height : DEFAULT_SHORTCUT_HEIGHT,
        collapsed: value.collapsed === true,
        items: Array.isArray(value.items) ? value.items.filter((item): item is Shortcut => !!item && typeof item.id === "string" && typeof item.name === "string" && typeof item.command === "string" && (item.mode === "fill" || item.mode === "execute")) : []
      };
    }
    return { defaults: { collapsed: raw?.defaults?.collapsed === true }, sessions };
  } catch { return { defaults: { collapsed: false }, sessions: {} }; }
}

export function setupShortcutsUi(deps: ShortcutsUiDeps) {
  const panel = document.getElementById("shortcuts-panel") as HTMLElement;
  const list = document.getElementById("shortcuts-list") as HTMLElement;
  const status = document.getElementById("shortcuts-status") as HTMLElement;
  const handle = document.getElementById("shortcuts-resizer") as HTMLElement;
  const toggle = document.getElementById("shortcuts-toggle") as HTMLButtonElement;
  const chevron = document.getElementById("shortcuts-chevron") as HTMLElement;
  const dialog = document.getElementById("shortcut-overlay") as HTMLElement;
  const form = document.getElementById("shortcut-form") as HTMLFormElement;
  const nameInput = document.getElementById("shortcut-name") as HTMLInputElement;
  const commandInput = document.getElementById("shortcut-command") as HTMLTextAreaElement;
  const error = document.getElementById("shortcut-error") as HTMLElement;
  const fileInput = document.getElementById("shortcuts-file") as HTMLInputElement;
  const store = readStore();
  const sessions = store.sessions;
  let defaultsCollapsed = store.defaults.collapsed;
  let boundId = "";
  let current: SessionShortcutPrefs = { height: DEFAULT_SHORTCUT_HEIGHT, collapsed: defaultsCollapsed, items: [] };
  let editingId: string | null = null;
  const saveStore = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ defaults: { collapsed: defaultsCollapsed }, sessions })); } catch { /* Keep working in memory when storage is unavailable. */ } };
  const saveCurrent = () => { if (!boundId) return; sessions[boundId] = { ...current, items: [...current.items] }; defaultsCollapsed = current.collapsed; saveStore(); };
  const availableHeight = () => {
    const container = panel.parentElement;
    if (!container) return window.innerHeight;
    const fixed = ["files-head", "files-path", "files-refreshed", "files-foot"]
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => !!element && !element.hidden)
      .reduce((total, element) => total + element.getBoundingClientRect().height, 0);
    return Math.max(0, container.getBoundingClientRect().height - fixed);
  };
  const applyHeight = () => { current.height = clampShortcutHeight(current.height, availableHeight()); panel.style.setProperty("--shortcuts-height", `${current.height}px`); };
  const applyCollapsed = () => { panel.classList.toggle("collapsed", current.collapsed); toggle.setAttribute("aria-expanded", String(!current.collapsed)); toggle.title = current.collapsed ? "展开快捷指令" : "收起快捷指令"; chevron.textContent = current.collapsed ? "▸" : "▾"; handle.hidden = current.collapsed; };
  function persistAndRender() { saveCurrent(); render(); }
  function openEditor(item?: Shortcut) {
    editingId = item?.id ?? null;
    document.getElementById("shortcut-dialog-title")!.textContent = item ? "编辑快捷指令" : "新建快捷指令";
    nameInput.value = item?.name ?? ""; commandInput.value = item?.command ?? "";
    const mode = item?.mode ?? "execute";
    (form.querySelector(`input[name="shortcut-mode"][value="${mode}"]`) as HTMLInputElement).checked = true;
    error.textContent = ""; dialog.hidden = false; nameInput.focus();
    if (!item) nameInput.select();
  }
  function closeEditor() { dialog.hidden = true; editingId = null; }
  function actionButton(text: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.className = "shortcut-action"; button.textContent = text; button.title = title; button.setAttribute("aria-label", title); button.disabled = !deps.sessionId(); button.addEventListener("click", action); return button;
  }
  function render() {
    list.textContent = "";
    if (!deps.sessionId()) { status.textContent = "无会话"; return; }
    status.textContent = current.items.length ? "" : "暂无快捷指令";
    current.items.forEach((item, index) => {
      const row = document.createElement("div"); row.className = "shortcut-row";
      const activate = document.createElement("button"); activate.type = "button"; activate.className = "shortcut-card"; activate.title = item.command;
      const label = document.createElement("span"); label.className = "shortcut-name"; label.textContent = item.name || "未命名指令";
      const command = document.createElement("span"); command.className = "shortcut-command"; command.textContent = item.command || "（点击编辑，添加命令）";
      const badge = document.createElement("span"); badge.className = `shortcut-mode ${item.mode}`; badge.textContent = item.mode === "execute" ? "执行" : "填入";
      activate.append(label, command, badge);
      activate.addEventListener("click", () => { if (!item.command) openEditor(item); else if (item.mode === "fill") deps.fill(item.command); else void deps.execute(item.command).catch((err) => { status.textContent = String(err); }); });
      const controls = document.createElement("div"); controls.className = "shortcut-controls";
      const up = actionButton("↑", "上移", () => { current.items = moveShortcut(current.items, index, -1); persistAndRender(); });
      const down = actionButton("↓", "下移", () => { current.items = moveShortcut(current.items, index, 1); persistAndRender(); });
      const edit = actionButton("✎", "编辑", () => openEditor(item));
      const remove = actionButton("×", "删除", () => { current.items = current.items.filter((entry) => entry.id !== item.id); persistAndRender(); });
      up.disabled = index === 0; down.disabled = index === current.items.length - 1; controls.append(up, down, edit, remove); row.append(activate, controls); list.append(row);
    });
  }
  function bindSession(id: string) {
    if (id === boundId) return;
    saveCurrent(); boundId = id;
    const saved = id ? sessions[id] : undefined;
    current = saved ? { ...saved, height: clampShortcutHeight(saved.height, availableHeight()), items: [...saved.items] } : { height: DEFAULT_SHORTCUT_HEIGHT, collapsed: defaultsCollapsed, items: [] };
    applyHeight(); applyCollapsed(); render();
  }

  document.getElementById("shortcuts-new")!.addEventListener("click", () => {
    if (!deps.sessionId()) return;
    const item: Shortcut = { id: crypto.randomUUID(), name: "", command: "", mode: "execute" };
    current.items.push(item); saveCurrent(); render(); openEditor(item);
  });
  toggle.addEventListener("click", () => { current.collapsed = !current.collapsed; applyCollapsed(); saveCurrent(); deps.layoutChanged(); });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || current.collapsed) return;
    event.preventDefault();
    dragHeight(event, handle, { startHeight: panel.getBoundingClientRect().height, edge: "bottom", clamp: (value) => clampShortcutHeight(value, availableHeight()), onHeight: (height) => { current.height = height; applyHeight(); }, onEnd: (_height, moved) => { if (moved) { saveCurrent(); deps.layoutChanged(); } } });
  });
  handle.addEventListener("dblclick", () => { current.height = clampShortcutHeight(DEFAULT_SHORTCUT_HEIGHT, availableHeight()); applyHeight(); saveCurrent(); deps.layoutChanged(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const name = nameInput.value.trim();
    if (!name) { error.textContent = "请输入名称"; nameInput.focus(); return; }
    const mode = form.querySelector<HTMLInputElement>('input[name="shortcut-mode"]:checked')?.value as ShortcutMode;
    const item: Shortcut = { id: editingId ?? crypto.randomUUID(), name, command: commandInput.value, mode };
    const index = current.items.findIndex((entry) => entry.id === editingId);
    if (index < 0) current.items.push(item); else current.items[index] = item;
    persistAndRender(); closeEditor();
  });
  document.getElementById("shortcut-cancel")!.addEventListener("click", closeEditor);
  document.getElementById("shortcut-dialog-close")!.addEventListener("click", closeEditor);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeEditor(); });
  window.addEventListener("keydown", (event) => { if (!dialog.hidden && event.key === "Escape") closeEditor(); });
  document.getElementById("shortcuts-import")!.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try {
      const imported = parseShortcutExport(await file.text()).map((item) => ({ ...item, id: crypto.randomUUID() }));
      current.items.push(...imported); persistAndRender(); status.textContent = `已导入 ${imported.length} 条`;
    } catch (err) { status.textContent = String(err); }
  });
  document.getElementById("shortcuts-export")!.addEventListener("click", async () => {
    const defaultPath = await invoke<string>("shortcuts_export_default_path").catch(() => "pinshell-shortcuts.json");
    try {
      const path = await save({
        title: "导出会话指令集",
        defaultPath,
        filters: [{ name: "JSON 指令集", extensions: ["json"] }]
      });
      if (!path) return;
      await invoke("shortcuts_export_file", {
        path,
        contents: JSON.stringify({ version: 1, items: current.items }, null, 2)
      });
      status.textContent = `已导出到 ${path}`;
    } catch (err) {
      status.textContent = `导出失败：${String(err)}`;
    }
  });
  window.addEventListener("resize", () => { const before = current.height; applyHeight(); if (before !== current.height) saveCurrent(); });
  bindSession(deps.sessionId());
  return { selectSession(id: string) { bindSession(id); } };
}
