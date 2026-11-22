// 文件面板的界面部分：只负责把意图发给核心、把结果画出来。
// 排序、隐藏过滤与截断都在 core-domain；这里不做第二份规则。

import { invoke } from "@tauri-apps/api/core";
import { setupFoldPanel } from "./panelFold";
import { onLocaleChange, t } from "./i18n";
import { closePopupMenu, isPopupMenuOpen, showPopupMenu } from "./popupMenu";
import {
  AUTO_REFRESH_MS,
  autoRefreshDelay,
  blankMenu,
  clampPanelWidth,
  DEFAULT_FILE_PANEL_HEIGHT,
  formatSize,
  formatTime,
  joinPath,
  normalizePanelStore,
  normalizePath,
  panelTarget,
  parentPath,
  parseSortDir,
  parseSortField,
  pathSegments,
  rowMenu,
  sameListing,
  sortEntries,
  SORT_DIR_KEY,
  SORT_FIELD_KEY,
  type FilePanelMode,
  type FilePanelPrefs,
  type FilePanelStore,
  type FileSortDir,
  type FileSortField,
  type FsEntry,
  type FsListing,
  type MenuCommand,
  type RowKind
} from "./filePanel";
// 拖动调宽/调高的手势与 body 上的类名三个面板共用，别各自再写一份
import { DRAGGING_CLASS, dragHeight, dragWidth } from "./resize";
import { clampPanelHeight, RIGHT_BAR_EVENT } from "./rightBar";
import { panelColumnBudget } from "./rightBarUi";

export interface FilePanelDeps {
  /// 当前焦点会话的 id；没有会话时返回空串
  sessionId(): string;
  /// 该会话记住的 CWD（来自 `session_tree`），没有就返回 null
  cwdOf(id: string): string | null;
  /// 填入输入条（命令片段的「填充」出口），不发送
  fillInput(text: string): void;
  /// 面板宽度变了：让终端重新 fit 并把新尺寸下给 PTY
  layoutChanged(): void;
}

const STORE_KEY = "pinshell.files";

/// 列表顶部「..」行的名字。真实的文件名不会是 `..`，所以可以拿它当选中行的身份。
const PARENT_ROW_NAME = "..";

function loadStored(): FilePanelStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return normalizePanelStore(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizePanelStore(null);
  }
}

/// 拖动时把宽度夹进合法区间；规则在 `filePanel.ts`，这里只提供窗口与左栏的实时宽度。
export function setupFilePanel(deps: FilePanelDeps) {
  const root = document.getElementById("files") as HTMLElement;
  const expandBtn = document.getElementById("files-expand") as HTMLButtonElement;
  const modeBtn = document.getElementById("files-mode") as HTMLButtonElement;
  const sortBtn = document.getElementById("files-sort") as HTMLButtonElement;
  const refreshBtn = document.getElementById("files-refresh") as HTMLButtonElement;
  const hiddenBtn = document.getElementById("files-hidden") as HTMLButtonElement;
  const pathEl = document.getElementById("files-path") as HTMLDivElement;
  const listEl = document.getElementById("files-list") as HTMLDivElement;
  const footEl = document.getElementById("files-foot") as HTMLDivElement;
  const resizer = document.getElementById("files-resizer") as HTMLDivElement;
  const autoBtn = document.getElementById("files-auto") as HTMLButtonElement;
  const refreshedEl = document.getElementById("files-refreshed") as HTMLDivElement;
  // 左栏自己也能拖宽，所以上限要现量它，不能写死 196
  const sidebar = document.getElementById("sidebar");
  const clampWidth = (desired: number) =>
    clampPanelWidth(desired, window.innerWidth, sidebar?.getBoundingClientRect().width ?? 196);

  const stored = loadStored();
  /// 整栏是否向右收起成 26px 竖条（窗口级布局）
  let collapsed = stored.collapsed;
  /// 文件子栏是否收起（只隐藏列表，标题栏留在原处）
  let expanded = stored.expanded;
  let width = stored.width;
  /// 文件子栏的高度（窗口级布局）。轮到它吃剩余高度时忽略这个值。
  let height = stored.height;

  // 文件子栏的标题栏折叠：与串口、快捷指令共用 panelFold，样式与交互一致。
  // 「谁吃剩余高度」由 rightBarUi 按顺序统一裁定，这里不再有 files-folded 特例。
  const fold = setupFoldPanel({
    root: document.getElementById("files-panel") as HTMLElement,
    toggle: document.getElementById("files-toggle") as HTMLElement,
    chevron: document.getElementById("files-chevron"),
    label: t("files.title"),
    collapsed: !expanded,
    onChange: (next) => {
      expanded = !next;
      save();
      deps.layoutChanged();
      scheduleAuto();
      if (expanded && !lastListing) void reload();
    }
  });
  /// 每个会话各自的设置；`defaults` 给还没有自己记录的会话（也是旧版数据的迁移落点）
  const sessions = stored.sessions;
  let defaults = stored.defaults;
  /// 当前设置绑定到哪个会话。切换会话时整套换掉，宽度与展开状态不动。
  let boundId: string | null = null;
  let mode: FilePanelMode = defaults.mode;
  let showHidden = defaults.showHidden;
  let auto = defaults.auto;
  let sortField: FileSortField = parseSortField(localStorage.getItem(SORT_FIELD_KEY));
  let sortDir: FileSortDir = parseSortDir(localStorage.getItem(SORT_DIR_KEY), sortField);
  let currentPath: string | null = null;
  /// 路径栏此刻显示的路径：面包屑与「编辑路径」都用它，错误目录也能显示。
  let shownPath = "";
  /// 路径栏正在输入：自动刷新重画列表时不能把输入框换掉，否则打了一半的路径会丢。
  let pathEditing = false;
  let lastListing: FsListing | null = null;
  /// 列表拉不到时后端给不出 `parent`，这份值由前端按路径算出来，
  /// 保证「读不出来的目录」也能通过列表里的 `..` 退出去。
  let upTarget: string | null = null;
  let token = 0;
  let selected: HTMLElement | null = null;
  /// 重画后按名字恢复选中：自动刷新每 3 秒重建一次列表，不能把用户点的那行弄丢
  let selectedName: string | null = null;
  /// 自动刷新的定时器与连续失败次数（失败要退避，别对断开的网络盘每 3 秒重试）
  let autoTimer: number | undefined;
  let autoFailures = 0;

  // ---------- 右键菜单 ----------
  // 原生菜单由 helper 进程弹（系统 Shell 的 IContextMenu）；它起不来时用这份自建
  // 菜单兜底，所以两边都在。自建菜单走 `popupMenu`，与会话菜单共用一套字体与键盘操作。
  interface MenuTarget {
    path: string;
    kind: RowKind;
  }
  /// 右键序号：期间又右键了别的行，先回来的那次就作废（不能弹两个菜单）
  let menuToken = 0;

  function showFallbackMenu(x: number, y: number, target: MenuTarget) {
    showPopupMenu(
      { x, y },
      rowMenu(target.kind).map((item) => ({
        label: item.label,
        run: () => void runMenuCommand(target, item.command)
      })),
      { minWidth: 180 }
    );
  }

  async function openContextMenu(x: number, y: number, target: MenuTarget) {
    closePopupMenu();
    const mine = ++menuToken;
    try {
      const outcome = await invoke<string>("fs_context_menu", { path: target.path });
      if (mine !== menuToken) return;
      if (outcome === "unavailable") showFallbackMenu(x, y, target);
    } catch {
      if (mine !== menuToken) return;
      showFallbackMenu(x, y, target);
    }
  }

  /// 空白处的原生菜单：目录自己的背景菜单（新建 / 粘贴 / 属性……），
  /// 与右键某个文件时的条目菜单不是同一份，所以单独走 `background`。
  async function openBlankMenu(x: number, y: number, path: string) {
    closePopupMenu();
    const mine = ++menuToken;
    try {
      const outcome = await invoke<string>("fs_context_menu", { path, background: true });
      if (mine !== menuToken) return;
      if (outcome === "unavailable") showBlankFallback(x, y, path);
    } catch {
      if (mine !== menuToken) return;
      showBlankFallback(x, y, path);
    }
  }

  function showBlankFallback(x: number, y: number, path: string) {
    showPopupMenu(
      { x, y },
      blankMenu().map((item) => ({
        label: item.label,
        run: () => void runMenuCommand({ path, kind: "dir" }, item.command)
      })),
      { minWidth: 180 }
    );
  }

  async function runMenuCommand(target: MenuTarget, command: MenuCommand) {
    try {
      if (command === "open") {
        if (target.kind === "dir" || target.kind === "parent") {
          enter(target.path);
        } else {
          await invoke("fs_open", { path: target.path });
        }
      } else if (command === "reveal") {
        await invoke("fs_reveal", { path: target.path });
      } else if (command === "copy") {
        await navigator.clipboard.writeText(target.path);
        footEl.textContent = t("files.copied");
      } else if (command === "refresh") {
        await reload();
      } else {
        deps.fillInput(target.path);
      }
    } catch (err) {
      footEl.textContent = String(err);
    }
  }

  /// 当前会话此刻的设置快照。跟随模式不记路径：路径由后端按 CWD 解析。
  function capturePrefs(): FilePanelPrefs {
    return { mode, auto, showHidden, path: mode === "fixed" ? currentPath : null };
  }

  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ collapsed, expanded, width, height, defaults, sessions })
      );
    } catch {
      // 存不下就只影响下次打开的默认值，不打断使用
    }
  }

  /// 改动落到「当前会话」名下，同时成为新建会话的默认值。
  function save() {
    const prefs = capturePrefs();
    if (boundId) sessions[boundId] = prefs;
    defaults = prefs;
    persist();
  }

  /// 切换会话：换上该会话自己的跟随/固定、自动刷新、显示隐藏项。
  /// 面板宽度与展开状态是窗口级布局，切会话时保持不动。
  function bindSession(id: string) {
    if (id === boundId) return;
    // 先把上一个会话当下的状态写回去：它可能一直用着默认值，却从没被记录过
    if (boundId) {
      sessions[boundId] = capturePrefs();
      persist();
    }
    boundId = id;
    // 让旧会话尚未返回的目录请求失效，避免覆盖新会话的首屏列表。
    token++;
    // 新会话沿用最近一次用过的设置，但不继承它的固定路径：从自己的 CWD 起步更合理
    const prefs = (id ? sessions[id] : undefined) ?? { ...defaults, path: null };
    mode = prefs.mode;
    auto = prefs.auto;
    showHidden = prefs.showHidden;
    currentPath = prefs.path;
    pathEditing = false;
    // 上一个会话的列表、选中行与菜单都不能留在新会话里
    lastListing = null;
    selected = null;
    selectedName = null;
    upTarget = null;
    autoFailures = 0;
    stopAuto();
    closePopupMenu();
    syncChrome();
  }

  /// 文件子栏折叠：只收起内容，标题栏与工具按钮留在原处。
  /// 整栏折叠是另一件事（`applyCollapsed`），两者互不覆盖。
  /// 文件子栏折叠状态上 DOM。只在初始化时调用：之后由 `fold` 的 onChange 接管。
  function applyExpanded() {
    fold.set(!expanded, true);
  }

  /// 整栏折叠：宽度收成 26px 竖条，只留一个竖排的展开按钮。
  /// `silent` 为 true 时不重排终端（初始化阶段由调用方统一做一次）。
  function applyCollapsed(silent = false) {
    root.classList.toggle("collapsed", collapsed);
    expandBtn.hidden = !collapsed;
    expandBtn.title = t("rightbar.expand");
    expandBtn.setAttribute("aria-label", t("rightbar.expand"));
    persist();
    // 收起时没有列表可刷，展开时立刻补一次
    scheduleAuto();
    if (!silent) deps.layoutChanged();
  }

  /// 设置整栏折叠状态。展开时若还没有列表就顺手拉一次。
  function setCollapsed(next: boolean) {
    if (next === collapsed) return;
    collapsed = next;
    applyCollapsed();
    if (!collapsed && !lastListing) void reload();
  }

  /// 排序按钮上的文案：字段 + 方向箭头。
  function sortLabel(field: FileSortField, dir: FileSortDir): string {
    const name = field === "name" ? t("files.sortName") : t("files.sortCreated");
    return `${name} ${dir === "asc" ? "↑" : "↓"}`;
  }

  /// 与列表内容无关的按钮状态：自动刷新跳过重画时，这些也要跟着更新。
  function syncChrome() {
    modeBtn.textContent = mode === "follow" ? t("files.follow") : t("files.fixed");
    modeBtn.title = mode === "follow" ? t("files.followHint") : t("files.fixedHint");
    modeBtn.classList.toggle("on", mode === "follow");
    hiddenBtn.classList.toggle("on", showHidden);
    autoBtn.classList.toggle("on", auto);
    const seconds = Math.round(autoRefreshDelay(lastListing?.total ?? 0, 0) / 1000);
    autoBtn.title = auto
      ? t("files.autoOn", { n: seconds })
      : t("files.autoOff", { n: AUTO_REFRESH_MS / 1000 });
    autoBtn.setAttribute("aria-label", t("files.auto"));
    refreshedEl.dataset.auto = String(auto);
    refreshedEl.hidden = !auto;
    if (auto && !refreshedEl.textContent) refreshedEl.textContent = t("files.waiting");
    // 排序按钮的文案就是当前排序方式；点它弹出的菜单里再选字段与方向
    const sort = sortLabel(sortField, sortDir);
    sortBtn.textContent = sort;
    sortBtn.title = t("files.sortHint", { sort });
    sortBtn.setAttribute("aria-label", sortBtn.title);
  }

  function showLastRefresh(now: Date) {
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
    refreshedEl.textContent = t("files.refreshedAt", { time });
    refreshedEl.dataset.auto = String(auto);
    refreshedEl.hidden = !auto;
  }

  /// 路径栏：可点的面包屑 + 右侧「编辑路径」。单击某一段直接进那个目录，
  /// 点 ✎（或双击路径栏空白处）换成输入框，输入完整路径后回车跳转。
  function showPath(path: string) {
    shownPath = path;
    if (pathEditing) return;
    pathEl.textContent = "";
    pathEl.title = path;
    if (!path) {
      pathEl.textContent = t("files.noSession");
      return;
    }
    const crumbs = document.createElement("div");
    crumbs.className = "f-crumbs";
    pathSegments(path).forEach((segment, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "f-crumb-sep";
        sep.textContent = "›";
        crumbs.append(sep);
      }
      const crumb = document.createElement("span");
      crumb.className = "f-crumb";
      crumb.textContent = segment.name;
      crumb.title = segment.path;
      crumb.addEventListener("mousedown", (event) => event.preventDefault());
      crumb.addEventListener("click", () => {
        if (segment.path !== currentPath) enter(segment.path);
      });
      crumbs.append(crumb);
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "f-path-edit";
    edit.textContent = "✎";
    edit.title = t("files.editPath");
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("mousedown", (event) => event.preventDefault());
    edit.addEventListener("click", () => startEditPath());
    pathEl.append(crumbs, edit);
  }

  /// 路径栏进入编辑态：输入完整路径，回车跳转、Esc 或失焦还原。
  function startEditPath() {
    if (!shownPath) return;
    const input = document.createElement("input");
    input.className = "f-path-input";
    input.type = "text";
    input.value = shownPath;
    input.spellcheck = false;
    input.autocomplete = "off";
    pathEl.textContent = "";
    pathEl.append(input);
    pathEditing = true;
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      pathEditing = false;
      showPath(shownPath);
    };
    input.addEventListener("keydown", (event) => {
      // 路径输入框里的按键不往外走：否则 Enter / Ctrl+R 会被全局快捷键拿走
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        const next = normalizePath(input.value);
        done = true;
        pathEditing = false;
        if (next && next !== shownPath) {
          enter(next);
        } else {
          showPath(shownPath);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        restore();
      }
    });
    input.addEventListener("blur", restore);
    // 编辑态允许放光标，所以不阻止默认（单击面包屑时才阻止，避免抢走终端焦点）
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.focus();
    input.select();
  }

  function render(listing: FsListing) {
    // 列表重建时菜单还开着，就会指向一行已经不存在的条目
    closePopupMenu();
    // 同一目录自动刷新时保住滚动位置与选中行；换了目录才从头开始
    const sameDir = lastListing !== null && lastListing.path === listing.path;
    const keepScroll = sameDir ? listEl.scrollTop : 0;
    const keepSelected = sameDir ? selectedName : null;

    lastListing = listing;
    const entries = sortEntries(listing.entries, sortField, sortDir);
    // 跟随模式下后端按会话 CWD 解析出了实际路径；固定模式下就是请求的那条
    currentPath = listing.path;
    showPath(listing.path);
    upTarget = listing.parent;

    listEl.textContent = "";
    selected = null;
    selectedName = null;
    // 顶部先放一行「..」：和头部 ↑ 是同一件事，但习惯在列表里上翻的人不该被迫去点那个小按钮
    if (listing.parent) {
      const up = renderParentRow(listing.parent);
      if (keepSelected === PARENT_ROW_NAME) {
        selected = up;
        selectedName = PARENT_ROW_NAME;
        up.classList.add("sel");
      }
      listEl.append(up);
    }
    if (!listing.entries.length) {
      const empty = document.createElement("div");
      empty.className = "f-empty";
      empty.textContent = listing.hidden_count && !showHidden ? t("files.emptyHidden") : t("files.emptyDir");
      listEl.append(empty);
    }
    for (const entry of entries) {
      const row = renderRow(listing.path, entry);
      if (entry.name === keepSelected) {
        selected = row;
        selectedName = entry.name;
        row.classList.add("sel");
      }
      listEl.append(row);
    }
    listEl.scrollTop = keepScroll;

    const parts = [t("files.count", { n: listing.entries.length })];
    if (listing.hidden_count) parts.push(t("files.hiddenCount", { n: listing.hidden_count }));
    if (listing.truncated) parts.push(t("files.truncated", { n: listing.entries.length }));
    footEl.textContent = parts.join(" · ");
  }

  /// 选中一行：同一时刻只有一行带 `sel`。
  function select(row: HTMLElement, name: string) {
    if (selected === row) return;
    selected?.classList.remove("sel");
    selected = row;
    selectedName = name;
    row.classList.add("sel");
  }

  /// 列表顶部的「..」行。它不是目录里的真实条目，所以没有大小和时间，
  /// 提示里放的是目标路径；双击回退一级，和头部 ↑ 走同一条 `enter`。
  function renderParentRow(parent: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "f-row dir up";
    row.title = parent;

    const icon = document.createElement("span");
    icon.className = "f-icon";
    icon.textContent = "↑";

    const name = document.createElement("span");
    name.className = "f-name";
    name.textContent = PARENT_ROW_NAME;

    row.append(icon, name);
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => select(row, PARENT_ROW_NAME));
    row.addEventListener("dblclick", () => enter(parent));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      select(row, PARENT_ROW_NAME);
      void openContextMenu(event.clientX, event.clientY, { path: parent, kind: "parent" });
    });
    return row;
  }

  function renderRow(dir: string, entry: FsEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "f-row" + (entry.kind === "dir" ? " dir" : "");
    row.title = entry.name + (entry.hidden ? t("files.hiddenMark") : "");

    const icon = document.createElement("span");
    icon.className = "f-icon";
    icon.textContent = entry.kind === "dir" ? "▸" : "·";

    const name = document.createElement("span");
    name.className = "f-name";
    name.textContent = entry.name;
    if (entry.link) {
      const mark = document.createElement("span");
      mark.className = "f-link";
      mark.textContent = "↗";
      mark.title = t("files.link");
      name.append(mark);
    }

    const size = document.createElement("span");
    size.className = "f-size";
    size.textContent = formatSize(entry);

    const time = document.createElement("span");
    time.className = "f-time";
    time.textContent = formatTime(entry.modified_ms);

    row.append(icon, name, size, time);
    // 点面板不该把焦点从终端或输入条抢走：按钮与行都在 mousedown 上阻止默认
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => select(row, entry.name));
    row.addEventListener("dblclick", () => {
      if (entry.kind === "dir") {
        enter(joinPath(dir, entry.name));
      } else {
        deps.fillInput(joinPath(dir, entry.name));
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      select(row, entry.name);
      void openContextMenu(event.clientX, event.clientY, {
        path: joinPath(dir, entry.name),
        kind: entry.kind
      });
    });
    return row;
  }

  function enter(path: string) {
    // 手动导航即转成固定路径：否则 Shell 每 cd 一次，面板就把用户拽走
    mode = "fixed";
    currentPath = path;
    save();
    void reload();
  }

  // ---------- 路径栏 ----------
  // 单击面包屑进目录；编辑按钮（或双击路径栏空白处）进编辑态。
  pathEl.addEventListener("mousedown", (event) => {
    // 编辑态要允许放光标；其余情况阻止默认，别把焦点从终端抢走
    if ((event.target as HTMLElement).closest(".f-path-input")) return;
    event.preventDefault();
  });
  pathEl.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest(".f-path-input, .f-path-edit, .f-crumb")) return;
    startEditPath();
  });

  // ---------- 列表空白处 ----------
  // 点空白：让列表自己拿到焦点（随后 F5 才有落点），并清掉行选中。
  // 行自己的 mousedown 会阻止默认，这里按事件目标区分，不抢终端焦点。
  listEl.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (target !== listEl && !target.classList.contains("f-empty")) return;
    event.preventDefault();
    listEl.focus();
    selected?.classList.remove("sel");
    selected = null;
    selectedName = null;
  });
  // 空白处右键：目录自己的 Shell 背景菜单（新建 / 粘贴 / 属性……）
  listEl.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement;
    if (target !== listEl && !target.classList.contains("f-empty")) return;
    event.preventDefault();
    listEl.focus();
    const path = lastListing?.path ?? currentPath ?? shownPath;
    if (path) void openBlankMenu(event.clientX, event.clientY, path);
  });
  // 文件栏里按 F5 刷新：只在列表（空白处点过之后）有焦点时接管，
  // 终端里的 F5 照常发给 Shell。
  listEl.addEventListener("keydown", (event) => {
    if (event.key !== "F5") return;
    event.preventDefault();
    event.stopPropagation();
    void reload();
  });

  /// 现在允许自动刷新吗：开关开着、面板展开、整栏没收起、有会话、窗口可见、且不在拖拽中。
  /// 任一不满足就不排期，省掉白读盘，也不会在拖动面板时插进一次重绘。
  function canAuto(): boolean {
    return (
      auto &&
      expanded &&
      !collapsed &&
      !root.hidden &&
      deps.sessionId() !== "" &&
      document.visibilityState === "visible" &&
      !isPopupMenuOpen() &&
      !document.body.classList.contains(DRAGGING_CLASS)
    );
  }

  function stopAuto() {
    if (autoTimer === undefined) return;
    window.clearTimeout(autoTimer);
    autoTimer = undefined;
  }

  /// 从此刻起重新计时。每次拉取结束、切换开关、展开面板都走这里，
  /// 保证「上一次回来之后再等一个周期」，慢盘上不会把请求堆起来。
  function scheduleAuto() {
    stopAuto();
    if (!canAuto()) return;
    autoTimer = window.setTimeout(
      () => void autoTick(),
      autoRefreshDelay(lastListing?.total ?? 0, autoFailures)
    );
  }

  async function autoTick(): Promise<void> {
    autoTimer = undefined;
    if (!canAuto()) return;
    const ok = await reload();
    autoFailures = ok ? 0 : Math.min(autoFailures + 1, 3);
    scheduleAuto(); // 按更新后的失败次数重排；成功时与 reload 里排的那次等价
  }

  /// 拉一次目录。返回 false 表示没拉成（没会话、被更新的请求取代、读盘失败）。
  async function reload(sessionOverride?: string): Promise<boolean> {
    // 面板被取消勾选时不读盘；重新勾选时由 `pinshell:rightbar` 补一次
    if (root.hidden) return false;
    const id = sessionOverride ?? deps.sessionId();
    // 切了会话就先换上它自己的设置，再按那套设置决定列哪个目录
    bindSession(id);
    if (!id) {
      showPath("");
      listEl.textContent = "";
      footEl.textContent = "";
      upTarget = null;
      lastListing = null;
      selected = null;
      selectedName = null;
      syncChrome();
      scheduleAuto();
      return false;
    }
    const target = panelTarget(mode, deps.cwdOf(id), currentPath);
    const mine = ++token;
    try {
      const listing = await invoke<FsListing>("fs_list", {
        session: id,
        path: target,
        showHidden
      });
      if (mine !== token || id !== boundId || id !== (sessionOverride ?? deps.sessionId())) return false;
      // 内容完全一样就不动 DOM：自动刷新不该每 3 秒把列表重建一遍
      if (!sameListing(lastListing, listing)) render(listing);
      showLastRefresh(new Date());
      return true;
    } catch (err) {
      if (mine !== token || id !== boundId || id !== (sessionOverride ?? deps.sessionId())) return false;
      lastListing = null;
      selected = null;
      selectedName = null;
      // 读不出来的目录也得能退出去：后端没结果就没有 `parent`，这里按路径自己算一份，
      // 头部 ↑ 与列表顶部的「..」照常可用（否则一个没有权限的目录会把人卡死在里面）。
      const shown = target ?? currentPath ?? deps.cwdOf(id) ?? "";
      upTarget = parentPath(shown);
      showPath(shown);
      listEl.textContent = "";
      if (upTarget) listEl.append(renderParentRow(upTarget));
      const row = document.createElement("div");
      row.className = "f-empty";
      row.textContent = String(err);
      listEl.append(row);
      footEl.textContent = "";
      return false;
    } finally {
      syncChrome();
      scheduleAuto();
    }
  }

  // 面板按钮一律不抢焦点：点完还能接着在终端里敲键盘
  for (const button of [expandBtn, modeBtn, sortBtn, refreshBtn, hiddenBtn, autoBtn]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  // 排序方式：按钮上是当前值，点开是一份菜单（原生 select 的下拉列表由系统绘制，
  // 字体与配色都跟主界面不一致，暗黑主题下尤其突兀）。
  // 菜单把「字段 × 方向」四种组合直接列出来，一次点击就选完。
  function setSort(field: FileSortField, dir: FileSortDir) {
    if (field === sortField && dir === sortDir) return;
    sortField = field;
    sortDir = dir;
    localStorage.setItem(SORT_FIELD_KEY, field);
    localStorage.setItem(SORT_DIR_KEY, dir);
    syncChrome();
    if (lastListing) render(lastListing);
  }

  sortBtn.addEventListener("click", () => {
    const options: Array<{ field: FileSortField; dir: FileSortDir; label: string }> = [
      { field: "name", dir: "asc", label: t("files.sortNameAsc") },
      { field: "name", dir: "desc", label: t("files.sortNameDesc") },
      { field: "created", dir: "asc", label: t("files.sortCreatedAsc") },
      { field: "created", dir: "desc", label: t("files.sortCreatedDesc") }
    ];
    showPopupMenu(
      sortBtn,
      options.map((option) => ({
        label: option.label,
        checked: option.field === sortField && option.dir === sortDir,
        run: () => setSort(option.field, option.dir)
      })),
      { minWidth: 168 }
    );
  });

  // 整栏展开的入口只剩收起后那条竖条；收起动作由标题栏上的按钮发起
  expandBtn.addEventListener("click", () => setCollapsed(false));
  refreshBtn.addEventListener("click", () => void reload());
  autoBtn.addEventListener("click", () => {
    auto = !auto;
    autoFailures = 0;
    save();
    syncChrome();
    if (auto) {
      void reload(); // 立刻刷一次，用户马上能看到开关生效
    } else {
      stopAuto();
    }
  });
  hiddenBtn.addEventListener("click", () => {
    showHidden = !showHidden;
    save();
    void reload();
  });
  modeBtn.addEventListener("click", () => {
    mode = mode === "follow" ? "fixed" : "follow";
    if (mode === "fixed") currentPath = lastListing?.path ?? deps.cwdOf(deps.sessionId());
    save();
    void reload();
  });

  // ---------- 子栏高度 ----------
  // 三个面板共用一套规则：各自记住高度，最后一个展开的面板由 rightBarUi 挂 `rb-fill` 撑满；
  // 撑满时手柄被 CSS 收掉，这里也拦一道，防止点到已经隐藏的手柄。
  const heightHandle = document.getElementById("files-height") as HTMLDivElement;
  /// 夹取高度：既不超过可用高度的 70%，也不把别的定高面板挤到栏底之外。
  /// 可用高度为 0（整栏收起）时 `panelColumnBudget` 会退回窗口高度。
  const clampHeight = (desired: number) => {
    const budget = panelColumnBudget(root);
    return clampPanelHeight(Math.min(desired, budget.room), budget.available);
  };
  function applyHeight() {
    height = clampHeight(height);
    root.style.setProperty("--files-height", `${height}px`);
  }

  heightHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !expanded || root.classList.contains("rb-fill")) return;
    event.preventDefault();
    dragHeight(event, heightHandle, {
      edge: "bottom",
      startHeight: root.getBoundingClientRect().height,
      clamp: clampHeight,
      onHeight: (next) => {
        height = next;
        applyHeight();
      },
      onEnd: (_next, moved) => {
        if (!moved) return;
        save();
        deps.layoutChanged();
      }
    });
  });
  heightHandle.addEventListener("dblclick", () => {
    height = clampHeight(DEFAULT_FILE_PANEL_HEIGHT);
    applyHeight();
    save();
    deps.layoutChanged();
  });

  // 左边缘拖动调宽：拖动中只改 CSS 宽度，终端保持原尺寸、由 #term-host 裁掉多出来的部分，
  // 松手后才重排一次终端并把新尺寸下给 PTY（拖动中每跨一列就重排会让会话区不停闪）。
  // 双击恢复按窗口比例的默认宽度。手势本体在 `resize.ts`，与左栏共用。
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopAuto(); // 拖动期间不插自动刷新，松手后再重新计时
    dragWidth(event, resizer, {
      edge: "left",
      startWidth: root.getBoundingClientRect().width,
      clamp: clampWidth,
      onWidth: (next) => {
        width = next;
        root.style.setProperty("--files-width", `${next}px`);
      },
      onEnd: (_next, moved) => {
        scheduleAuto();
        if (!moved) return;
        save();
        deps.layoutChanged();
      }
    });
  });

  resizer.addEventListener("dblclick", () => {
    width = 0;
    root.style.removeProperty("--files-width");
    save();
    deps.layoutChanged();
  });

  if (width > 0) {
    // 上次退出时的窗口可能比现在宽：先夹一遍，别把终端挤到看不见
    width = clampWidth(width);
    root.style.setProperty("--files-width", `${width}px`);
  }
  syncChrome();
  applyHeight();
  // 整栏折叠先上 DOM：子栏折叠状态与之无关，两者分别恢复
  applyCollapsed(true);
  applyExpanded();
  // 初始化阶段统一重排一次，别让上面两步各触发一遍终端 fit
  deps.layoutChanged();

  // 窗口变窄时把已保存的宽度重新夹一遍，否则固定的 px 会把终端挤到看不见
  window.addEventListener("resize", () => {
    const nextHeight = clampHeight(height);
    if (nextHeight !== height) {
      height = nextHeight;
      applyHeight();
      save();
    }
    if (!width || collapsed) return;
    const next = clampWidth(width);
    if (next === width) return;
    width = next;
    root.style.setProperty("--files-width", `${next}px`);
    save();
    deps.layoutChanged();
  });

  // 功能栏的结构变了（面板被勾掉/显出来、上下顺序变了）：隐藏期间停掉定时器，
  // 重新出现时补一次列表——否则回来的是一份上次留下的旧目录内容。
  document.addEventListener(RIGHT_BAR_EVENT, () => {
    scheduleAuto();
    if (!root.hidden && expanded && !collapsed && !lastListing) void reload();
  });

  // 窗口被遮住/最小化时没必要继续读盘；回到前台先补一次（这期间文件可能变了）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAuto();
    } else if (auto) {
      void reload();
    }
  });

  // 语言变了：静态标注由 main 统一刷，这里补面板名、按钮与当前列表
  onLocaleChange(() => {
    const title = document.getElementById("files-panel")?.querySelector(".panel-title");
    if (title) title.textContent = t("files.title");
    fold.set(fold.collapsed, true);
    syncChrome();
    if (lastListing) render(lastListing);
  });

  return {
    /// 会话切换后调用：跟随模式会立刻按新会话的 CWD 重画
    reload,
    /// 在终端附着开始时切换设置并立刻加载目标会话的文件列表。
    selectSession(id: string) {
      void reload(id);
    },
    /// 收到 `session:cwd` 时调用：只有跟随模式和当前会话才需要动
    onCwd(id: string) {
      if (mode !== "follow" || id !== deps.sessionId()) return;
      void reload();
    },
    /// 整栏是否收起
    get collapsed() {
      return collapsed;
    },
    /// 切换整栏折叠；标题栏按钮与「展开」竖条都走这里
    toggle() {
      setCollapsed(!collapsed);
    },
    setCollapsed
  };
}
