// 文件面板的界面部分：只负责把意图发给核心、把结果画出来。
// 排序、隐藏过滤与截断都在 core-domain；这里不做第二份规则。

import { invoke } from "@tauri-apps/api/core";
import {
  formatSize,
  formatTime,
  joinPath,
  panelTarget,
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
}

const STORE_KEY = "pinshell.files";

function loadStored(): Stored {
  const fallback: Stored = { expanded: true, showHidden: false, mode: "follow" };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      expanded: parsed.expanded !== false,
      showHidden: parsed.showHidden === true,
      mode: parsed.mode === "fixed" ? "fixed" : "follow"
    };
  } catch {
    return fallback;
  }
}

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

  const stored = loadStored();
  let mode: FilePanelMode = stored.mode;
  let showHidden = stored.showHidden;
  let expanded = stored.expanded;
  let currentPath: string | null = null;
  let lastListing: FsListing | null = null;
  let token = 0;
  let selected: HTMLElement | null = null;

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ expanded, showHidden, mode }));
    } catch {
      // 存不下就只影响下次打开的默认值，不打断使用
    }
  }

  function applyExpanded() {
    root.classList.toggle("collapsed", !expanded);
    expandBtn.hidden = expanded;
    save();
    deps.layoutChanged();
  }

  function render(listing: FsListing) {
    lastListing = listing;
    // 跟随模式下后端按会话 CWD 解析出了实际路径；固定模式下就是请求的那条
    currentPath = listing.path;
    pathEl.textContent = listing.path;
    pathEl.title = listing.path;
    upBtn.disabled = !listing.parent;

    modeBtn.textContent = mode === "follow" ? "跟随" : "固定";
    modeBtn.title =
      mode === "follow"
        ? "面板跟随当前会话的 CWD；点一下改成固定路径"
        : "面板停在固定路径；点一下恢复跟随当前会话";
    modeBtn.classList.toggle("on", mode === "follow");
    hiddenBtn.classList.toggle("on", showHidden);

    listEl.textContent = "";
    selected = null;
    if (!listing.entries.length) {
      const empty = document.createElement("div");
      empty.className = "f-empty";
      empty.textContent = listing.hidden_count && !showHidden ? "（只有隐藏项）" : "（空目录）";
      listEl.append(empty);
    }
    for (const entry of listing.entries) {
      listEl.append(renderRow(listing.path, entry));
    }

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

  async function reload(): Promise<void> {
    const id = deps.sessionId();
    if (!id) {
      pathEl.textContent = "无会话";
      listEl.textContent = "";
      footEl.textContent = "";
      upBtn.disabled = true;
      return;
    }
    const target = panelTarget(mode, deps.cwdOf(id), currentPath);
    const mine = ++token;
    try {
      const listing = await invoke<FsListing>("fs_list", {
        session: id,
        path: target,
        showHidden
      });
      if (mine !== token) return; // 期间切了会话或又导航了一次，丢弃过期结果
      render(listing);
    } catch (err) {
      if (mine !== token) return;
      lastListing = null;
      pathEl.textContent = currentPath ?? "";
      listEl.textContent = "";
      const row = document.createElement("div");
      row.className = "f-empty";
      row.textContent = String(err);
      listEl.append(row);
      footEl.textContent = "";
      upBtn.disabled = true;
    }
  }

  // 面板按钮一律不抢焦点：点完还能接着在终端里敲键盘
  for (const button of [expandBtn, collapseBtn, modeBtn, upBtn, refreshBtn, hiddenBtn]) {
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

  applyExpanded();

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
