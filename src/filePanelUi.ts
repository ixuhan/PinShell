// 文件面板的界面部分：只负责把意图发给核心、把结果画出来。
// 排序、隐藏过滤与截断都在 core-domain；这里不做第二份规则。

import { invoke } from "@tauri-apps/api/core";
import {
  AUTO_REFRESH_MS,
  autoRefreshDelay,
  clampMenuPosition,
  clampPanelWidth,
  formatSize,
  formatTime,
  joinPath,
  normalizePanelStore,
  panelTarget,
  parentPath,
  rowMenu,
  sameListing,
  type FilePanelMode,
  type FilePanelPrefs,
  type FilePanelStore,
  type FsEntry,
  type FsListing,
  type MenuCommand,
  type MenuItem,
  type RowKind
} from "./filePanel";
// 拖动调宽的手势与 body 上的类名左右两栏共用，别各自再写一份
import { DRAGGING_CLASS, dragWidth } from "./resize";

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
  const collapseBtn = document.getElementById("files-collapse") as HTMLButtonElement;
  const modeBtn = document.getElementById("files-mode") as HTMLButtonElement;
  const upBtn = document.getElementById("files-up") as HTMLButtonElement;
  const refreshBtn = document.getElementById("files-refresh") as HTMLButtonElement;
  const hiddenBtn = document.getElementById("files-hidden") as HTMLButtonElement;
  const pathEl = document.getElementById("files-path") as HTMLDivElement;
  const listEl = document.getElementById("files-list") as HTMLDivElement;
  const footEl = document.getElementById("files-foot") as HTMLDivElement;
  const resizer = document.getElementById("files-resizer") as HTMLDivElement;
  const autoBtn = document.getElementById("files-auto") as HTMLButtonElement;
  // 左栏自己也能拖宽，所以上限要现量它，不能写死 196
  const sidebar = document.getElementById("sidebar");
  const clampWidth = (desired: number) =>
    clampPanelWidth(desired, window.innerWidth, sidebar?.getBoundingClientRect().width ?? 196);

  const stored = loadStored();
  let expanded = stored.expanded;
  let width = stored.width;
  /// 每个会话各自的设置；`defaults` 给还没有自己记录的会话（也是旧版数据的迁移落点）
  const sessions = stored.sessions;
  let defaults = stored.defaults;
  /// 当前设置绑定到哪个会话。切换会话时整套换掉，宽度与展开状态不动。
  let boundId: string | null = null;
  let mode: FilePanelMode = defaults.mode;
  let showHidden = defaults.showHidden;
  let auto = defaults.auto;
  let currentPath: string | null = null;
  let lastListing: FsListing | null = null;
  /// 头部 ↑ 的目标。列表拉不到时后端给不出 `parent`，这份值由前端按路径算出来，
  /// 保证「读不出来的目录」也能退出去，不会把人卡在里面。
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
  // 菜单兜底，所以两边都在。菜单不抢焦点：键盘走 document 捕获阶段，点外面即关。
  interface MenuTarget {
    path: string;
    kind: RowKind;
  }
  const menuEl = document.createElement("div");
  menuEl.className = "f-menu";
  menuEl.hidden = true;
  menuEl.setAttribute("role", "menu");
  document.body.append(menuEl);
  let menuTarget: MenuTarget | null = null;
  let menuItems: MenuItem[] = [];
  let menuIndex = -1;
  /// 右键序号：期间又右键了别的行，先回来的那次就作废（不能弹两个菜单）
  let menuToken = 0;

  function hideMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    menuEl.textContent = "";
    menuTarget = null;
    menuItems = [];
    menuIndex = -1;
  }

  function setMenuIndex(index: number) {
    if (!menuItems.length) return;
    menuIndex = (index + menuItems.length) % menuItems.length;
    Array.from(menuEl.children).forEach((row, position) =>
      row.classList.toggle("sel", position === menuIndex)
    );
  }

  function showFallbackMenu(x: number, y: number, target: MenuTarget) {
    menuTarget = target;
    menuItems = rowMenu(target.kind);
    menuIndex = -1;
    menuEl.textContent = "";
    menuItems.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "f-menu-item";
      row.setAttribute("role", "menuitem");
      row.textContent = item.label;
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => void runMenuCommand(item.command));
      row.addEventListener("pointerenter", () => setMenuIndex(index));
      menuEl.append(row);
    });
    // 先渲染再量尺寸：菜单贴到右下角时要往回收，量 0×0 会把它顶到角上
    menuEl.hidden = false;
    const rect = menuEl.getBoundingClientRect();
    const spot = clampMenuPosition(
      x,
      y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight
    );
    menuEl.style.left = `${spot.x}px`;
    menuEl.style.top = `${spot.y}px`;
    setMenuIndex(0);
  }

  async function openContextMenu(x: number, y: number, target: MenuTarget) {
    hideMenu();
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

  async function runMenuCommand(command: MenuCommand) {
    const target = menuTarget;
    hideMenu();
    if (!target) return;
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
        footEl.textContent = "已复制路径";
      } else {
        deps.fillInput(target.path);
      }
    } catch (err) {
      footEl.textContent = String(err);
    }
  }

  // 菜单打开时，键盘事件在捕获阶段截住：输入条仍有焦点也不能把 ↑↓/Enter 吃掉
  document.addEventListener(
    "keydown",
    (event) => {
      if (menuEl.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideMenu();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setMenuIndex(menuIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setMenuIndex(menuIndex - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const item = menuItems[menuIndex];
        if (item) void runMenuCommand(item.command);
      }
    },
    true
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (menuEl.hidden) return;
      if (event.target instanceof Node && menuEl.contains(event.target)) return;
      hideMenu();
    },
    true
  );
  window.addEventListener("blur", hideMenu);
  window.addEventListener("resize", hideMenu);

  /// 当前会话此刻的设置快照。跟随模式不记路径：路径由后端按 CWD 解析。
  function capturePrefs(): FilePanelPrefs {
    return { mode, auto, showHidden, path: mode === "fixed" ? currentPath : null };
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ expanded, width, defaults, sessions }));
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
    // 新会话沿用最近一次用过的设置，但不继承它的固定路径：从自己的 CWD 起步更合理
    const prefs = (id ? sessions[id] : undefined) ?? { ...defaults, path: null };
    mode = prefs.mode;
    auto = prefs.auto;
    showHidden = prefs.showHidden;
    currentPath = prefs.path;
    // 上一个会话的列表、选中行与菜单都不能留在新会话里
    lastListing = null;
    selected = null;
    selectedName = null;
    upTarget = null;
    autoFailures = 0;
    stopAuto();
    hideMenu();
    syncChrome();
  }

  function applyExpanded() {
    root.classList.toggle("collapsed", !expanded);
    expandBtn.hidden = expanded;
    save();
    deps.layoutChanged();
    // 收起时 canAuto() 为 false 会停掉定时器；展开则重新开始计时
    scheduleAuto();
  }

  /// 与列表内容无关的按钮状态：自动刷新跳过重画时，这些也要跟着更新。
  function syncChrome() {
    modeBtn.textContent = mode === "follow" ? "跟随" : "固定";
    modeBtn.title =
      mode === "follow"
        ? "面板跟随当前会话的 CWD；点一下改成固定路径"
        : "面板停在固定路径；点一下恢复跟随当前会话";
    modeBtn.classList.toggle("on", mode === "follow");
    hiddenBtn.classList.toggle("on", showHidden);
    autoBtn.classList.toggle("on", auto);
    const seconds = Math.round(autoRefreshDelay(lastListing?.total ?? 0, 0) / 1000);
    autoBtn.title = auto
      ? `自动刷新已开：当前目录每 ${seconds} 秒刷新一次，点一下关闭`
      : `自动刷新：每 ${AUTO_REFRESH_MS / 1000} 秒刷新一次（大目录自动放慢），点一下开启`;
  }

  function render(listing: FsListing) {
    // 列表重建时菜单还开着，就会指向一行已经不存在的条目
    hideMenu();
    // 同一目录自动刷新时保住滚动位置与选中行；换了目录才从头开始
    const sameDir = lastListing !== null && lastListing.path === listing.path;
    const keepScroll = sameDir ? listEl.scrollTop : 0;
    const keepSelected = sameDir ? selectedName : null;

    lastListing = listing;
    // 跟随模式下后端按会话 CWD 解析出了实际路径；固定模式下就是请求的那条
    currentPath = listing.path;
    pathEl.textContent = listing.path;
    pathEl.title = listing.path;
    upTarget = listing.parent;
    upBtn.disabled = !listing.parent;

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
      empty.textContent = listing.hidden_count && !showHidden ? "（只有隐藏项）" : "（空目录）";
      listEl.append(empty);
    }
    for (const entry of listing.entries) {
      const row = renderRow(listing.path, entry);
      if (entry.name === keepSelected) {
        selected = row;
        selectedName = entry.name;
        row.classList.add("sel");
      }
      listEl.append(row);
    }
    listEl.scrollTop = keepScroll;

    const parts = [`${listing.entries.length} 项`];
    if (listing.hidden_count) parts.push(`隐藏 ${listing.hidden_count}`);
    if (listing.truncated) parts.push(`只显示前 ${listing.entries.length} 项`);
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
    row.title = entry.name + (entry.hidden ? "（隐藏）" : "");

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
      mark.title = "符号链接";
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

  /// 现在允许自动刷新吗：开关开着、面板展开、有会话、窗口可见、且不在拖拽中。
  /// 任一不满足就不排期，省掉白读盘，也不会在拖动面板时插进一次重绘。
  function canAuto(): boolean {
    return (
      auto &&
      expanded &&
      deps.sessionId() !== "" &&
      document.visibilityState === "visible" &&
      menuEl.hidden &&
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
  async function reload(): Promise<boolean> {
    const id = deps.sessionId();
    // 切了会话就先换上它自己的设置，再按那套设置决定列哪个目录
    bindSession(id);
    if (!id) {
      pathEl.textContent = "无会话";
      listEl.textContent = "";
      footEl.textContent = "";
      upTarget = null;
      upBtn.disabled = true;
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
      if (mine !== token) return false; // 期间切了会话或又导航了一次，丢弃过期结果
      // 内容完全一样就不动 DOM：自动刷新不该每 3 秒把列表重建一遍
      if (!sameListing(lastListing, listing)) render(listing);
      return true;
    } catch (err) {
      if (mine !== token) return false;
      lastListing = null;
      selected = null;
      selectedName = null;
      // 读不出来的目录也得能退出去：后端没结果就没有 `parent`，这里按路径自己算一份，
      // 头部 ↑ 与列表顶部的「..」照常可用（否则一个没有权限的目录会把人卡死在里面）。
      const shown = target ?? currentPath ?? deps.cwdOf(id) ?? "";
      upTarget = parentPath(shown);
      pathEl.textContent = shown;
      pathEl.title = shown;
      listEl.textContent = "";
      if (upTarget) listEl.append(renderParentRow(upTarget));
      const row = document.createElement("div");
      row.className = "f-empty";
      row.textContent = String(err);
      listEl.append(row);
      footEl.textContent = "";
      upBtn.disabled = !upTarget;
      return false;
    } finally {
      syncChrome();
      scheduleAuto();
    }
  }

  // 面板按钮一律不抢焦点：点完还能接着在终端里敲键盘
  for (const button of [expandBtn, collapseBtn, modeBtn, upBtn, refreshBtn, hiddenBtn, autoBtn]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  expandBtn.addEventListener("click", () => {
    expanded = true;
    applyExpanded();
    if (!lastListing) void reload();
  });
  collapseBtn.addEventListener("click", () => {
    expanded = false;
    applyExpanded();
  });
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
  upBtn.addEventListener("click", () => {
    if (upTarget) enter(upTarget);
  });
  modeBtn.addEventListener("click", () => {
    mode = mode === "follow" ? "fixed" : "follow";
    if (mode === "fixed") currentPath = lastListing?.path ?? deps.cwdOf(deps.sessionId());
    save();
    void reload();
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
    // 上次退出时的窗口可能比现在宽：先夹一遍，别一启动就把终端挤没
    width = clampWidth(width);
    root.style.setProperty("--files-width", `${width}px`);
  }
  syncChrome();
  applyExpanded();

  // 窗口变窄时把已保存的宽度重新夹一遍，否则固定的 px 会把终端挤到看不见
  window.addEventListener("resize", () => {
    if (!width || !expanded) return;
    const next = clampWidth(width);
    if (next === width) return;
    width = next;
    root.style.setProperty("--files-width", `${next}px`);
    save();
    deps.layoutChanged();
  });

  // 窗口被遮住/最小化时没必要继续读盘；回到前台先补一次（这期间文件可能变了）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopAuto();
    } else if (auto) {
      void reload();
    }
  });

  return {
    /// 会话切换后调用：跟随模式会立刻按新会话的 CWD 重画
    reload,
    /// 收到 `session:cwd` 时调用：只有跟随模式和当前会话才需要动
    onCwd(id: string) {
      if (mode !== "follow" || id !== deps.sessionId()) return;
      void reload();
    }
  };
}
