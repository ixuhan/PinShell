// 左栏的拖动调宽与收起/展开：只把宽度写进 CSS、把偏好存进 localStorage，
// 规则的算法在 `sidebar.ts`。
//
// 两种折叠不是一回事，别混在一起：
// - 整栏折叠：宽度收成 26px 竖条，由标题栏上的按钮切换（`BarToggle`）；
// - 子栏折叠：会话子栏自己的标题栏，只收起列表，宽度不变。

import { dragWidth } from "./resize";
import { parseFolded, serializeFolded, setupFoldPanel } from "./panelFold";
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth, parseStored, serializePrefs } from "./sidebar";
import { onLocaleChange, t } from "./i18n";

const STORE_KEY = "pinshell.sidebar";
/// 会话子栏自己的折叠状态，和整栏折叠分开存：整栏展开回来时它该保持原样
const FOLD_KEY = "pinshell.sessions.folded";

export interface SidebarDeps {
  /// 宽度或折叠状态变了：让终端重新 fit 并把新尺寸下给 PTY
  layoutChanged(): void;
}

export interface SidebarHandle {
  /// 整栏是否收起
  readonly collapsed: boolean;
  /// 切换整栏折叠；标题栏按钮与「展开」竖条都走这里
  toggle(): void;
  setCollapsed(collapsed: boolean): void;
}

export function setupSidebar(deps: SidebarDeps): SidebarHandle {
  const root = document.getElementById("sidebar") as HTMLElement;
  const resizer = document.getElementById("sess-resizer") as HTMLElement;
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

  // 会话子栏：标题栏单击折叠，只收内容不收整栏
  const sessFold = setupFoldPanel({
    root: document.getElementById("sess-panel") as HTMLElement,
    toggle: document.getElementById("sess-toggle") as HTMLElement,
    chevron: document.getElementById("sess-chevron"),
    label: t("sidebar.sessions"),
    collapsed: parseFolded(localStorage.getItem(FOLD_KEY)),
    onChange: (next) => {
      try {
        localStorage.setItem(FOLD_KEY, serializeFolded(next));
      } catch {
        // 同上：存不下只是下次打开恢复默认
      }
      // 串口的高度手柄向上伸出 5px，会压住这里的标题栏；
      // 让样式知道「上方已收起」，把那个手柄收回面板内部。
      root.classList.toggle("sess-folded", next);
      deps.layoutChanged();
    }
  });
  // 启动时也要同步一次：上次退出时可能正是收起状态
  root.classList.toggle("sess-folded", sessFold.collapsed);

  /// 把折叠状态搬到 DOM 上。展开时顺手夹一遍宽度：收起期间窗口可能变窄过。
  function syncCollapsed() {
    root.classList.toggle("collapsed", collapsed);
    expandBtn.hidden = !collapsed;
    expandBtn.title = t("sidebar.expand");
    expandBtn.setAttribute("aria-label", t("sidebar.expand"));
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

  // 整栏收起后，竖条上的「会话」就是展开入口；它不抢焦点，点完还能接着敲键盘
  expandBtn.addEventListener("mousedown", (event) => event.preventDefault());
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

  // 语言变了：竖条上的展开提示与「会话」二字都要换
  onLocaleChange(() => {
    syncCollapsed();
    sessFold.set(sessFold.collapsed, true);
    const label = root.querySelector(".panel-title");
    if (label) label.textContent = t("sidebar.sessions");
    expandBtn.textContent = t("sidebar.sessions");
  });

  return {
    get collapsed() {
      return collapsed;
    },
    toggle() {
      setCollapsed(!collapsed);
    },
    setCollapsed
  };
}
