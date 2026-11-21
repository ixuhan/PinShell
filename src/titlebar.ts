// 自绘标题栏：原生标题栏已在 tauri.conf.json 里关掉（decorations: false），
// 这条顶栏就是窗口唯一的装饰，所以拖动、双击最大化、三个窗口按钮都得自己接。
//
// 左侧工具区还放了「收起左栏 / 收起右栏 / 全局设置」三个按钮——它们属于窗口级布局，
// 放在标题栏比藏在各自侧栏的角落里更好找。样式在 styles.css 的 #titlebar 一节。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { onLocaleChange, t } from "./i18n";

/// 标题栏只需要两侧栏的「折叠」能力，不关心它们内部怎么实现。
export interface BarFold {
  readonly collapsed: boolean;
  toggle(): void;
}

export interface TitlebarDeps {
  left: BarFold;
  right: BarFold;
}

export function setupTitlebar(deps: TitlebarDeps): void {
  const dragArea = document.getElementById("titlebar-drag") as HTMLElement | null;
  const leftBtn = document.getElementById("bar-toggle-left") as HTMLButtonElement | null;
  const rightBtn = document.getElementById("bar-toggle-right") as HTMLButtonElement | null;
  const minimizeBtn = document.getElementById("win-minimize") as HTMLButtonElement | null;
  const maximizeBtn = document.getElementById("win-maximize") as HTMLButtonElement | null;
  const closeBtn = document.getElementById("win-close") as HTMLButtonElement | null;
  if (!dragArea || !leftBtn || !rightBtn || !minimizeBtn || !maximizeBtn || !closeBtn) return;

  const win = getCurrentWindow();
  let maximized = false;

  /// 最大化状态决定「最大化 / 还原」按钮的图标与提示。
  /// 用 `isMaximized()` 现问，不自己维护一份可能过期的布尔值。
  async function syncMaximizeButton(): Promise<void> {
    try {
      maximized = await win.isMaximized();
    } catch {
      // 拿不到就当未最大化：图标不准比抛错好
    }
    paintMaximizeButton();
  }

  function paintMaximizeButton(): void {
    maximizeBtn!.classList.toggle("restore", maximized);
    const key = maximized ? "titlebar.restore" : "titlebar.maximize";
    const label = t(key);
    maximizeBtn!.title = label;
    maximizeBtn!.setAttribute("aria-label", label);
  }

  /// 折叠按钮的按下态与提示跟着真实状态走。
  /// `aria-pressed` 同时是图标的依据：侧栏展开时图标那一块涂黑，收起时留空。
  function syncBarButtons(): void {
    for (const [button, bar, side] of [
      [leftBtn!, deps.left, "left"],
      [rightBtn!, deps.right, "right"]
    ] as const) {
      const collapsed = bar.collapsed;
      button.setAttribute("aria-pressed", String(collapsed));
      const key = collapsed
        ? side === "left" ? "titlebar.expandLeft" : "titlebar.expandRight"
        : side === "left" ? "titlebar.collapseLeft" : "titlebar.collapseRight";
      const label = t(key);
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  }

  // 按钮都不抢焦点：点完还能接着在终端里敲键盘
  for (const button of [leftBtn, rightBtn, minimizeBtn, maximizeBtn, closeBtn]) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  leftBtn.addEventListener("click", () => {
    deps.left.toggle();
    syncBarButtons();
  });
  rightBtn.addEventListener("click", () => {
    deps.right.toggle();
    syncBarButtons();
  });
  minimizeBtn.addEventListener("click", () => void win.minimize().catch(() => {}));
  maximizeBtn.addEventListener("click", () => {
    void win
      .toggleMaximize()
      .then(() => syncMaximizeButton())
      .catch((err) => {
        // 权限缺失时 toggleMaximize 会抛错；留一条日志，别让按钮静默失效
        console.warn(`[titlebar] toggleMaximize: ${String(err)}`);
      });
  });
  closeBtn.addEventListener("click", () => void win.close().catch(() => {}));

  // 拖动与双击最大化交给 Tauri 自带的拖动脚本（`data-tauri-drag-region="deep"`）：
  // 它在 mousedown 的 detail===1 时开始拖动、detail===2 时切一次最大化。
  // 这里别再自己挂 pointerdown/dblclick——两处各切一次会变成「切两次」，
  // 双击最大化后立刻又被切回原来的大小。
  //
  // 唯一要自己补的是图标同步：双击是 Tauri 脚本调的命令，不会经过我们的按钮回调。
  dragArea.addEventListener("dblclick", () => {
    // 让 Tauri 的 mousedown 处理先跑完再读状态
    window.setTimeout(() => void syncMaximizeButton(), 120);
  });

  // 两侧栏自己也可能因为别的原因改变折叠（竖条上的展开按钮），
  // 所以除了初始化，每次窗口尺寸变化时也顺手对齐一次按钮状态。
  syncBarButtons();
  void syncMaximizeButton();
  void win
    .onResized(() => {
      void syncMaximizeButton();
      syncBarButtons();
    })
    .catch(() => undefined);

  // 语言变了：提示文字全部重画（图标不变）
  onLocaleChange(() => {
    syncBarButtons();
    paintMaximizeButton();
  });
}
