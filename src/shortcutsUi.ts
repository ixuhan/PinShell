import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { enableDialogDrag, resetDialogPosition } from "./modalDrag";
import { ROW_ICON } from "./icons";
import { applyStaticI18n, onLocaleChange, t } from "./i18n";
import { setupFoldPanel } from "./panelFold";
import { dragHeight } from "./resize";
import { panelColumnBudget } from "./rightBarUi";
import { clampShortcutHeight, DEFAULT_SHORTCUT_HEIGHT, moveShortcut, parseShortcutExport, type SessionShortcutPrefs, type Shortcut, type ShortcutMode } from "./shortcuts";
import { invertIds, pruneIds, selectAllIds, toggleId } from "./selection";

const STORE_KEY = "pinshell.shortcuts";
/// 批量删除的二次确认时限：与左栏会话删除一致
const DELETE_CONFIRM_MS = 5000;
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
  const chevron = document.getElementById("shortcuts-chevron") as HTMLElement;
  const dialog = document.getElementById("shortcut-overlay") as HTMLElement;
  const form = document.getElementById("shortcut-form") as HTMLFormElement;
  enableDialogDrag(document.getElementById("shortcut-dialog-head")!, form);
  const nameInput = document.getElementById("shortcut-name") as HTMLInputElement;
  const commandInput = document.getElementById("shortcut-command") as HTMLTextAreaElement;
  const error = document.getElementById("shortcut-error") as HTMLElement;
  const fileInput = document.getElementById("shortcuts-file") as HTMLInputElement;
  const selectButton = document.getElementById("shortcuts-select") as HTMLButtonElement;
  const bulkBar = document.getElementById("shortcuts-bulk") as HTMLElement;
  const bulkSelectAll = document.getElementById("shortcuts-select-all") as HTMLButtonElement;
  const bulkInvert = document.getElementById("shortcuts-select-invert") as HTMLButtonElement;
  const bulkDelete = document.getElementById("shortcuts-delete-selected") as HTMLButtonElement;
  const bulkDone = document.getElementById("shortcuts-select-done") as HTMLButtonElement;
  const store = readStore();
  const sessions = store.sessions;
  let defaultsCollapsed = store.defaults.collapsed;
  let boundId = "";
  let current: SessionShortcutPrefs = { height: DEFAULT_SHORTCUT_HEIGHT, collapsed: defaultsCollapsed, items: [] };
  let editingId: string | null = null;
  /// 批量选择：进入后点卡片只勾选、不执行；勾选集合与左栏会话共用 `selection.ts`。
  let selectMode = false;
  let selected = new Set<string>();
  /// 批量删除同样要二次确认：第一次点把按钮换成「确认删除（n）」，5 秒内再点才删。
  let deleteArmed = false;
  let deleteArmTimer: number | undefined;
  const disarmDelete = () => {
    deleteArmed = false;
    window.clearTimeout(deleteArmTimer);
    deleteArmTimer = undefined;
  };
  /// 模式开关、勾选框与删除按钮的文案都跟着状态变，render 每次重画都会调。
  const paintBulk = () => {
    const hasSession = !!deps.sessionId();
    bulkBar.hidden = !selectMode || !hasSession;
    selectButton.classList.toggle("on", selectMode);
    selectButton.setAttribute("aria-pressed", String(selectMode));
    selectButton.disabled = !hasSession;
    const n = selected.size;
    bulkDelete.textContent = deleteArmed
      ? t("bulk.deleteConfirm", { n })
      : t("bulk.deleteCount", { n });
    bulkDelete.disabled = n === 0;
  };
  const setSelectMode = (on: boolean) => {
    if (selectMode === on) {
      paintBulk();
      return;
    }
    selectMode = on;
    selected = new Set();
    disarmDelete();
    if (on) {
      closeEditor();
      // 面板收着时进入批量模式看不见列表，先展开
      if (current.collapsed) fold.set(false);
    }
    render();
  };
  const toggleSelected = (id: string) => {
    selected = toggleId(selected, id);
    disarmDelete();
    render();
  };
  const saveStore = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ defaults: { collapsed: defaultsCollapsed }, sessions })); } catch { /* Keep working in memory when storage is unavailable. */ } };
  const saveCurrent = () => { if (!boundId) return; sessions[boundId] = { ...current, items: [...current.items] }; defaultsCollapsed = current.collapsed; saveStore(); };
  // 快捷指令区可用的纵向空间就是右栏内容区的高度，减去另外两个定高面板占掉的部分；
  // 上限（可用高度的 70%）与下限（120px）只在 `clampShortcutHeight` 里。
  const clampHeight = (value: number) => {
    const budget = panelColumnBudget(panel);
    return clampShortcutHeight(Math.min(value, budget.room), budget.available);
  };
  const applyHeight = () => { current.height = clampHeight(current.height); panel.style.setProperty("--shortcuts-height", `${current.height}px`); };
  // 子栏折叠统一走 panelFold：标题栏单击折叠，箭头与 aria 由它维护。
  // 折叠状态是会话级的，所以变化时要写回当前会话。
  const fold = setupFoldPanel({
    root: panel,
    toggle: document.getElementById("shortcuts-toggle") as HTMLElement,
    chevron,
    label: t("shortcuts.title"),
    collapsed: current.collapsed,
    onChange: (next) => {
      current.collapsed = next;
      handle.hidden = next;
      saveCurrent();
      deps.layoutChanged();
    }
  });
  /// 切会话/初始化时把已保存的折叠状态搬上 DOM；静默，避免把「同步」当成用户操作再存一遍。
  const applyCollapsed = () => {
    fold.set(current.collapsed, true);
    handle.hidden = current.collapsed;
  };
  function persistAndRender() { saveCurrent(); render(); }
  function openEditor(item?: Shortcut) {
    editingId = item?.id ?? null;
    document.getElementById("shortcut-dialog-title")!.textContent = item ? t("shortcuts.editTitle") : t("shortcuts.newTitle");
    nameInput.value = item?.name ?? ""; commandInput.value = item?.command ?? "";
    const mode = item?.mode ?? "execute";
    (form.querySelector(`input[name="shortcut-mode"][value="${mode}"]`) as HTMLInputElement).checked = true;
    error.textContent = ""; resetDialogPosition(form); dialog.hidden = false; nameInput.focus();
    if (!item) nameInput.select();
  }
  function closeEditor() { dialog.hidden = true; editingId = null; }
  // 图标走 ROW_ICON：四个按钮的粗细、圆角、留白一致，字符图标做不到这一点
  function actionButton(icon: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.className = "shortcut-action"; button.innerHTML = icon; button.title = title; button.setAttribute("aria-label", title); button.disabled = !deps.sessionId(); button.addEventListener("click", action); return button;
  }
  function render() {
    list.textContent = "";
    if (!deps.sessionId()) { status.textContent = t("files.noSession"); paintBulk(); return; }
    // 指令被删/导入后，勾选集合里不该留下已经不存在的 id
    selected = pruneIds(selected, current.items.map((item) => item.id));
    status.textContent = current.items.length ? "" : t("shortcuts.empty");
    current.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "shortcut-row"
        + (selectMode ? " selecting" : "")
        + (selectMode && selected.has(item.id) ? " selected" : "");
      const activate = document.createElement("button"); activate.type = "button"; activate.className = "shortcut-card"; activate.title = item.command;
      const label = document.createElement("span"); label.className = "shortcut-name"; label.textContent = item.name || t("shortcuts.unnamed");
      const command = document.createElement("span"); command.className = "shortcut-command"; command.textContent = item.command || t("shortcuts.clickToEdit");
      const badge = document.createElement("span"); badge.className = `shortcut-mode ${item.mode}`; badge.textContent = item.mode === "execute" ? t("shortcuts.execute") : t("shortcuts.fill");
      activate.append(label, command);
      activate.addEventListener("click", () => {
        if (selectMode) { toggleSelected(item.id); return; }
        if (!item.command) openEditor(item);
        else if (item.mode === "fill") deps.fill(item.command);
        else void deps.execute(item.command).catch((err) => { status.textContent = String(err); });
      });
      if (selectMode) {
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "shortcut-check";
        check.checked = selected.has(item.id);
        check.tabIndex = -1;
        check.setAttribute("aria-label", item.name || t("shortcuts.unnamed"));
        // 勾选交给复选框自己：点它不要冒泡到卡片，否则一次点击勾两次
        check.addEventListener("click", (event) => event.stopPropagation());
        check.addEventListener("change", () => toggleSelected(item.id));
        row.append(check);
      }
      if (selectMode) {
        // 批量模式下只留「勾选」这一种操作：上移/编辑/单条删除都收起来
        row.append(activate, badge);
        list.append(row);
        return;
      }
      const controls = document.createElement("div"); controls.className = "shortcut-controls";
      const up = actionButton(ROW_ICON.up, t("shortcuts.moveUp"), () => { current.items = moveShortcut(current.items, index, -1); persistAndRender(); });
      const down = actionButton(ROW_ICON.down, t("shortcuts.moveDown"), () => { current.items = moveShortcut(current.items, index, 1); persistAndRender(); });
      const edit = actionButton(ROW_ICON.edit, t("shortcuts.edit"), () => openEditor(item));
      const remove = actionButton(ROW_ICON.remove, t("shortcuts.remove"), () => { current.items = current.items.filter((entry) => entry.id !== item.id); persistAndRender(); });
      up.disabled = index === 0; down.disabled = index === current.items.length - 1; controls.append(up, down, edit, remove);
      // 执行/填入 是状态标签不是操作，放在卡片外面、与右侧四个按钮同一行对齐：
      // 塞进卡片里的话它只能贴在名字那一行，两行高的行里看着像浮在半空。
      row.append(activate, badge, controls); list.append(row);
    });
    paintBulk();
  }
  function bindSession(id: string) {
    if (id === boundId) return;
    saveCurrent(); boundId = id;
    // 换会话就退出批量模式：勾选的是上一个会话的指令，留着只会删错东西
    selected = new Set();
    selectMode = false;
    disarmDelete();
    const saved = id ? sessions[id] : undefined;
    current = saved ? { ...saved, height: clampHeight(saved.height), items: [...saved.items] } : { height: DEFAULT_SHORTCUT_HEIGHT, collapsed: defaultsCollapsed, items: [] };
    applyHeight(); applyCollapsed(); render();
  }

  document.getElementById("shortcuts-new")!.addEventListener("click", () => {
    if (!deps.sessionId()) return;
    openEditor();
  });

  // 批量选择：标题栏按钮切换模式，操作栏负责全选/反选/批量删除
  selectButton.addEventListener("click", () => setSelectMode(!selectMode));
  bulkDone.addEventListener("click", () => setSelectMode(false));
  bulkSelectAll.addEventListener("click", () => {
    selected = selectAllIds(current.items.map((item) => item.id));
    disarmDelete();
    render();
  });
  bulkInvert.addEventListener("click", () => {
    selected = invertIds(selected, current.items.map((item) => item.id));
    disarmDelete();
    render();
  });
  bulkDelete.addEventListener("click", () => {
    if (!selected.size) return;
    if (!deleteArmed) {
      deleteArmed = true;
      window.clearTimeout(deleteArmTimer);
      deleteArmTimer = window.setTimeout(() => {
        disarmDelete();
        if (selectMode) render();
      }, DELETE_CONFIRM_MS);
      render();
      return;
    }
    const n = selected.size;
    current.items = current.items.filter((entry) => !selected.has(entry.id));
    selected = new Set();
    disarmDelete();
    persistAndRender();
    status.textContent = t("shortcuts.batchDeleted", { n });
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || current.collapsed) return;
    event.preventDefault();
    dragHeight(event, handle, { startHeight: panel.getBoundingClientRect().height, edge: "bottom", clamp: clampHeight, onHeight: (height) => { current.height = height; applyHeight(); }, onEnd: (_height, moved) => { if (moved) { saveCurrent(); deps.layoutChanged(); } } });
  });
  handle.addEventListener("dblclick", () => { current.height = clampHeight(DEFAULT_SHORTCUT_HEIGHT); applyHeight(); saveCurrent(); deps.layoutChanged(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); const name = nameInput.value.trim();
    if (!name) { error.textContent = t("shortcuts.nameRequired"); nameInput.focus(); return; }
    const mode = form.querySelector<HTMLInputElement>('input[name="shortcut-mode"]:checked')?.value as ShortcutMode;
    const item: Shortcut = { id: editingId ?? crypto.randomUUID(), name, command: commandInput.value, mode };
    const index = current.items.findIndex((entry) => entry.id === editingId);
    if (index < 0) current.items.push(item); else current.items[index] = item;
    persistAndRender(); closeEditor();
  });
  document.getElementById("shortcut-cancel")!.addEventListener("click", closeEditor);
  document.getElementById("shortcut-dialog-close")!.addEventListener("click", closeEditor);
  window.addEventListener("keydown", (event) => { if (!dialog.hidden && event.key === "Escape") closeEditor(); });
  document.getElementById("shortcuts-import")!.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try {
      const imported = parseShortcutExport(await file.text()).map((item) => ({ ...item, id: crypto.randomUUID() }));
      current.items.push(...imported); persistAndRender(); status.textContent = t("shortcuts.imported", { n: imported.length });
    } catch (err) { status.textContent = String(err); }
  });
  document.getElementById("shortcuts-export")!.addEventListener("click", async () => {
    const defaultPath = await invoke<string>("shortcuts_export_default_path").catch(() => "pinshell-shortcuts.json");
    try {
      const path = await save({
        title: t("shortcuts.exportTitle"),
        defaultPath,
        filters: [{ name: t("shortcuts.exportFilter"), extensions: ["json"] }]
      });
      if (!path) return;
      await invoke("shortcuts_export_file", {
        path,
        contents: JSON.stringify({ version: 1, items: current.items }, null, 2)
      });
      status.textContent = t("shortcuts.exported", { path });
    } catch (err) {
      status.textContent = t("shortcuts.exportFailed", { error: String(err) });
    }
  });
  window.addEventListener("resize", () => { const before = current.height; applyHeight(); if (before !== current.height) saveCurrent(); });
  bindSession(deps.sessionId());

  // 语言变了：静态标注由 main 统一刷，这里重画列表与面板名
  onLocaleChange(() => {
    applyStaticI18n(document.getElementById("shortcut-overlay")!);
    const title = panel.querySelector(".panel-title");
    if (title) title.textContent = t("shortcuts.title");
    fold.set(fold.collapsed, true);
    render();
  });
  return { selectSession(id: string) { bindSession(id); } };
}
