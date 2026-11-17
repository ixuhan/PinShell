// 左栏的拖动调宽与收起/展开：只把宽度写进 CSS、把偏好存进 localStorage，
// 规则的算法在 `sidebar.ts`。

import { dragWidth } from "./resize";
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth, parseStored, serializePrefs } from "./sidebar";

const STORE_KEY = "pinshell.sidebar";

export interface SidebarDeps {
  /// 宽度或折叠状态变了：让终端重新 fit 并把新尺寸下给 PTY
  layoutChanged(): void;
}

export function setupSidebar(deps: SidebarDeps): void {
  const root = document.getElementById("sidebar") as HTMLElement;
  const resizer = document.getElementById("sess-resizer") as HTMLElement;
  const collapseBtn = document.getElementById("sess-collapse") as HTMLButtonElement;
  const expandBtn = document.getElementById("sess-expand") as HTMLButtonElement;
  const files = document.getElementById("files");

  // 文件面板折叠后只剩 26px，所以每次都现量，别缓存
  const filesWidth = () => files?.getBoundingClientRect().width ?? 0;
  const clamp = (desired: number) => clampSidebarWidth(desired, window.innerWidth, filesWidth());

  const stored = parseStored(localStorage.getItem(STORE_KEY));
  let width = clamp(stored.width);
  let collapsed = stored.collapsed;

  function applyWidth() {
    root.style.setProperty("--sidebar-width", `${width}px`);
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, serializePrefs({ width, collapsed }));
    } catch {
      // 存不下只影响下次打开的默认值，不打断使用
    }
  }

  /// 把折叠状态搬到 DOM 上。展开时顺手夹一遍宽度：收起期间窗口可能变窄过。
  function syncCollapsed() {
    root.classList.toggle("collapsed", collapsed);
    expandBtn.hidden = !collapsed;
    if (collapsed) return;
    width = clamp(width);
    applyWidth();
  }

  function setCollapsed(next: boolean) {
    if (next === collapsed) return;
    collapsed = next;
    syncCollapsed();
    save();
    deps.layoutChanged();
  }

  // 两侧按钮都不抢焦点：点完还能接着在终端里敲键盘
  for (const button of [collapseBtn, expandBtn]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  expandBtn.addEventListener("click", () => setCollapsed(false));

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || collapsed) return;
    event.preventDefault();
    dragWidth(event, resizer, {
      // 手柄在右边缘：往右拖是加宽
      edge: "right",
      startWidth: root.getBoundingClientRect().width,
      clamp,
      onWidth: (next) => {
        width = next;
        applyWidth();
      },
      onEnd: (next, moved) => {
        width = next;
        if (!moved) return; // 只是点了一下：不写配置、不重排
        save();
        deps.layoutChanged();
      }
    });
  });

  resizer.addEventListener("dblclick", () => {
    width = clamp(DEFAULT_SIDEBAR_WIDTH);
    applyWidth();
    save();
    deps.layoutChanged();
  });

  // 启动时先按当前窗口夹一遍：上次退出时的窗口可能比现在窄。
  // 收起状态下 --sidebar-width 不生效，展开时 syncCollapsed 会再夹一次。
  syncCollapsed();
  save(); // 顺手把旧版本存的纯数字升级成 JSON

  window.addEventListener("resize", () => {
    if (collapsed) return; // 只剩一条竖条，宽度等展开时再夹
    const next = clamp(width);
    if (next === width) return;
    width = next;
    applyWidth();
    save();
    deps.layoutChanged();
  });
}
