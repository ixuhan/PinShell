// 文件面板的界面部分：只负责把意图发给核心、把结果画出来。
// 排序、隐藏过滤与截断都在 core-domain；这里不做第二份规则。

import { invoke } from "@tauri-apps/api/core";
import {
  AUTO_REFRESH_MS,
  autoRefreshDelay,
  clampPanelWidth,
  formatSize,
  formatTime,
  joinPath,
  panelTarget,
  sameListing,
  type FilePanelMode,
  type FsEntry,
  type FsListing
} from "./filePanel";

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

interface Stored {
  expanded: boolean;
  showHidden: boolean;
  mode: FilePanelMode;
  /// 上次拖动的宽度；0 表示用默认的窗口比例
  width: number;
  /// 自动刷新开关；默认关，用户点「自动」才开
  auto: boolean;
}

const STORE_KEY = "pinshell.files";

/// 拖动面板宽度期间挂在 body 上的类：样式用它换光标，main.ts 用它把终端重排推迟到松手。
export const PANEL_DRAGGING_CLASS = "files-dragging";

function loadStored(): Stored {
  const fallback: Stored = { expanded: true, showHidden: false, mode: "follow", width: 0, auto: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const width = typeof parsed.width === "number" && Number.isFinite(parsed.width) ? Math.round(parsed.width) : 0;
    return {
      expanded: parsed.expanded !== false,
      showHidden: parsed.showHidden === true,
      mode: parsed.mode === "fixed" ? "fixed" : "follow",
      width: width > 0 ? width : 0,
      auto: parsed.auto === true
    };
  } catch {
    return fallback;
  }
}

/// 拖动时把宽度夹进合法区间；规则在 `filePanel.ts`，这里只提供窗口宽度。
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

  const stored = loadStored();
  let mode: FilePanelMode = stored.mode;
  let showHidden = stored.showHidden;
  let expanded = stored.expanded;
  let width = stored.width;
  let auto = stored.auto;
  let currentPath: string | null = null;
  let lastListing: FsListing | null = null;
  let token = 0;
  let selected: HTMLElement | null = null;
  /// 重画后按名字恢复选中：自动刷新每 3 秒重建一次列表，不能把用户点的那行弄丢
  let selectedName: string | null = null;
  /// 自动刷新的定时器与连续失败次数（失败要退避，别对断开的网络盘每 3 秒重试）
  let autoTimer: number | undefined;
  let autoFailures = 0;

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ expanded, showHidden, mode, width, auto }));
    } catch {
      // 存不下就只影响下次打开的默认值，不打断使用
    }
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
    // 同一目录自动刷新时保住滚动位置与选中行；换了目录才从头开始
    const sameDir = lastListing !== null && lastListing.path === listing.path;
    const keepScroll = sameDir ? listEl.scrollTop : 0;
    const keepSelected = sameDir ? selectedName : null;

    lastListing = listing;
    // 跟随模式下后端按会话 CWD 解析出了实际路径；固定模式下就是请求的那条
    currentPath = listing.path;
    pathEl.textContent = listing.path;
    pathEl.title = listing.path;
    upBtn.disabled = !listing.parent;

    listEl.textContent = "";
    selected = null;
    selectedName = null;
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
    row.addEventListener("click", () => {
      if (selected === row) return;
      selected?.classList.remove("sel");
      selected = row;
      selectedName = entry.name;
      row.classList.add("sel");
    });
    row.addEventListener("dblclick", () => {
      if (entry.kind === "dir") {
        enter(joinPath(dir, entry.name));
      } else {
        deps.fillInput(joinPath(dir, entry.name));
      }
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
      !document.body.classList.contains(PANEL_DRAGGING_CLASS)
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
    if (!id) {
      pathEl.textContent = "无会话";
      listEl.textContent = "";
      footEl.textContent = "";
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
      pathEl.textContent = currentPath ?? "";
      listEl.textContent = "";
      const row = document.createElement("div");
      row.className = "f-empty";
      row.textContent = String(err);
      listEl.append(row);
      footEl.textContent = "";
      upBtn.disabled = true;
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
    if (lastListing?.parent) enter(lastListing.parent);
  });
  modeBtn.addEventListener("click", () => {
    mode = mode === "follow" ? "fixed" : "follow";
    if (mode === "fixed") currentPath = lastListing?.path ?? deps.cwdOf(deps.sessionId());
    save();
    void reload();
  });

  // 左边缘拖动调宽：拖动中只改 CSS 宽度，终端保持原尺寸、由 #term-host 裁掉多出来的部分，
  // 松手后才重排一次终端并把新尺寸下给 PTY（拖动中每跨一列就重排会让会话区不停闪）。
  // 双击恢复按窗口比例的默认宽度。
  //
  // 监听器挂在 window 而不是手柄上：指针捕获在部分环境里会失败（抛 NotFoundError），
  // 一旦抛在 addEventListener 之前，整个手势就永远收不到 pointermove。
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopAuto(); // 拖动期间不插自动刷新，松手后再重新计时
    const startX = event.clientX;
    const startWidth = root.getBoundingClientRect().width;
    let moved = false;

    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败不要紧：下面的 window 监听照样收得到移动
    }

    const onMove = (moveEvent: PointerEvent) => {
      const next = clampPanelWidth(startWidth + (startX - moveEvent.clientX), window.innerWidth);
      if (next === width) return;
      width = next;
      moved = true;
      root.style.setProperty("--files-width", `${next}px`);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.body.classList.remove(PANEL_DRAGGING_CLASS);
      scheduleAuto();
      if (!moved) return;
      save();
      deps.layoutChanged();
    };

    document.body.classList.add(PANEL_DRAGGING_CLASS);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  });

  resizer.addEventListener("dblclick", () => {
    width = 0;
    root.style.removeProperty("--files-width");
    save();
    deps.layoutChanged();
  });

  if (width > 0) {
    // 上次退出时的窗口可能比现在宽：先夹一遍，别一启动就把终端挤没
    width = clampPanelWidth(width, window.innerWidth);
    root.style.setProperty("--files-width", `${width}px`);
  }
  syncChrome();
  applyExpanded();

  // 窗口变窄时把已保存的宽度重新夹一遍，否则固定的 px 会把终端挤到看不见
  window.addEventListener("resize", () => {
    if (!width || !expanded) return;
    const next = clampPanelWidth(width, window.innerWidth);
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
