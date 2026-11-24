// 查找条（Ctrl+Shift+F）：浮在分格右上角，每分格一条，状态按会话保留。
//
// 三条边界：
// 1. **只搜前端缓冲区**：数据源是 xterm 已经画出来的行，不读 scrollback/<id>.ansi、
//    不读会话日志。见 ADR 0009。
// 2. **addon 会自己绕回**：`findNext` 到最后一个之后回到第一个，而且没有关掉它的开关。
//    所以「循环查找」是我们这边的闸门——先问 `canStep`，不许走就根本不调 addon。
// 3. **切走隐藏、切回还原**：只有焦点分格显示查找条；另一格的查询、命中位置与高亮都留着。

import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { TerminalView } from "./terminalViews";
import { onLocaleChange, t } from "./i18n";
import {
  FIND_PREFS_KEY,
  canStep,
  formatHit,
  hasQuery,
  hitNumber,
  parseFindPrefs,
  serializeFindPrefs,
  type FindPrefs
} from "./findBar";

/// 每个按键重扫一遍 5000 行的代价不小，合并到这个窗口内一次性算。
const INPUT_DEBOUNCE_MS = 50;
/// 「到头了」的提示挂多久。
const EDGE_HINT_MS = 1200;

interface DecorationColors {
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
}

interface PaneFind {
  id: string;
  term: Terminal;
  search: SearchAddon;
  root: HTMLDivElement;
  input: HTMLInputElement;
  count: HTMLSpanElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  caseBtn: HTMLButtonElement;
  wrapBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  disposeResults: () => void;
  open: boolean;
  query: string;
  /// 1 起的「第几个命中」；0 表示当前没有命中。
  number: number;
  total: number;
  /// 这一轮查询是否真的跑过（区分「还没搜」与「搜了 0 个」）。
  searched: boolean;
  inputTimer: number | undefined;
  edgeTimer: number | undefined;
}

export interface FindBarDeps {
  /// 取会话的终端视图。冷格没有终端，返回 null，查找条也就没有入口。
  view: (id: string) => TerminalView | null;
  /// 当前焦点会话 id。
  activeId: () => string;
  /// 关闭后把焦点还给该还的地方：输入条拥有按键就回输入条，否则回终端。
  restoreFocus: (id: string) => void;
  /// 打开/关闭/焦点归属变了：让输入条重画状态点。
  changed: () => void;
}

export interface FindBarHandle {
  /// Ctrl+Shift+F：焦点分格开着就关，没开就打开。
  toggle: () => void;
  /// 该会话的查找条强制关闭（清屏时）。
  closeFor: (id: string) => void;
  /// 视图没了：把状态一起忘掉，别让同一个 id 复活时带回旧查询。
  forget: (id: string) => void;
  /// 焦点换到别的分格：只切可见性，不动内容。
  setActive: (id: string) => void;
  /// 查找条正拿着键盘焦点（此时所有权变化不该把焦点抢回去）。
  holdsKeys: () => boolean;
  /// 语言变了：重画文案。
  refreshText: () => void;
  /// 主题变了：已经画出来的高亮要按新配色重涂。
  recolor: () => void;
  prefs: () => FindPrefs;
}

const FALLBACK_COLORS: DecorationColors = {
  matchBackground: "#1c3a2d",
  matchBorder: "#46d19a",
  matchOverviewRuler: "#46d19a",
  activeMatchBackground: "#24674f",
  activeMatchBorder: "#46d19a",
  activeMatchColorOverviewRuler: "#46d19a"
};

function cssColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // xterm 的装饰只认 #RRGGBB，别把 rgb()/var() 这类值喂进去
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function decorationColors(): DecorationColors {
  return {
    matchBackground: cssColor("--accent-bg", FALLBACK_COLORS.matchBackground),
    matchBorder: cssColor("--accent", FALLBACK_COLORS.matchBorder),
    matchOverviewRuler: cssColor("--accent", FALLBACK_COLORS.matchOverviewRuler),
    // 当前命中用更实的绿：和「其它命中」拉开层次，浅色主题下也压得住
    activeMatchBackground: cssColor("--accent-solid", FALLBACK_COLORS.activeMatchBackground),
    activeMatchBorder: cssColor("--accent", FALLBACK_COLORS.activeMatchBorder),
    activeMatchColorOverviewRuler: cssColor("--accent", FALLBACK_COLORS.activeMatchColorOverviewRuler)
  };
}

export function setupFindBar(deps: FindBarDeps): FindBarHandle {
  const panes = new Map<string, PaneFind>();
  let prefs = readPrefs();

  function readPrefs(): FindPrefs {
    try {
      return parseFindPrefs(localStorage.getItem(FIND_PREFS_KEY));
    } catch {
      return parseFindPrefs(null);
    }
  }

  function savePrefs(): void {
    try {
      localStorage.setItem(FIND_PREFS_KEY, serializeFindPrefs(prefs));
    } catch {
      // 存不下只影响下次启动的默认值
    }
  }

  function render(pane: PaneFind): void {
    if (pane.edgeTimer !== undefined) {
      window.clearTimeout(pane.edgeTimer);
      pane.edgeTimer = undefined;
      pane.count.classList.remove("edge");
    }
    pane.count.textContent = formatHit(pane.number, pane.total);
    pane.root.classList.toggle("nomatch", pane.searched && hasQuery(pane.query) && pane.total === 0);
    pane.caseBtn.classList.toggle("on", prefs.caseSensitive);
    pane.caseBtn.setAttribute("aria-pressed", prefs.caseSensitive ? "true" : "false");
    pane.wrapBtn.classList.toggle("on", prefs.wrap);
    pane.wrapBtn.setAttribute("aria-pressed", prefs.wrap ? "true" : "false");
  }

  function paintText(pane: PaneFind): void {
    pane.input.placeholder = t("find.placeholder");
    pane.input.setAttribute("aria-label", t("find.placeholder"));
    pane.root.title = t("find.hint");
    pane.root.setAttribute("aria-label", t("find.hint"));
    pane.count.title = t("find.countHint");
    pane.prevBtn.title = t("find.prev");
    pane.nextBtn.title = t("find.next");
    pane.caseBtn.title = t("find.caseSensitive");
    pane.wrapBtn.title = t("find.wrap");
    pane.closeBtn.title = t("find.close");
  }

  function searchOptions() {
    return { caseSensitive: prefs.caseSensitive, decorations: decorationColors() };
  }

  function flashEdge(pane: PaneFind): void {
    if (pane.edgeTimer !== undefined) window.clearTimeout(pane.edgeTimer);
    pane.count.classList.add("edge");
    pane.count.textContent = t("find.edge");
    pane.edgeTimer = window.setTimeout(() => {
      pane.edgeTimer = undefined;
      pane.count.classList.remove("edge");
      pane.count.textContent = formatHit(pane.number, pane.total);
    }, EDGE_HINT_MS);
  }

  /// 接着当前位置跑一遍（空查询就清干净）。查询变了 addon 会从当前命中的起点继续找，
  /// 所以打字时是「在当前命中附近收窄」，不会每敲一个字就跳回屏幕顶端。
  function run(pane: PaneFind): void {
    if (!hasQuery(pane.query)) {
      pane.search.clearDecorations();
      pane.number = 0;
      pane.total = 0;
      pane.searched = false;
      render(pane);
      return;
    }
    pane.searched = true;
    pane.search.findNext(pane.query, { ...searchOptions(), incremental: true });
    if (pane.total === 0) render(pane); // 结果由 onDidChangeResults 回来，这里只是兜底
  }

  /// 从头来一次：清掉高亮与选区，让 addon 从缓冲区顶端开始找。
  function restart(pane: PaneFind): void {
    pane.search.clearDecorations();
    pane.term.clearSelection();
    run(pane);
  }

  function step(pane: PaneFind, delta: 1 | -1): void {
    if (!hasQuery(pane.query)) return;
    if (!pane.searched) {
      run(pane);
      return;
    }
    // 一个命中都没有：输入框已经描红，不必再喊「到头了」
    if (pane.total === 0) return;
    if (!canStep(pane.number, pane.total, delta, prefs.wrap)) {
      flashEdge(pane);
      return;
    }
    const options = { ...searchOptions(), incremental: false };
    if (delta > 0) pane.search.findNext(pane.query, options);
    else pane.search.findPrevious(pane.query, options);
  }

  function close(pane: PaneFind, focusBack: boolean): void {
    if (pane.inputTimer !== undefined) window.clearTimeout(pane.inputTimer);
    pane.inputTimer = undefined;
    pane.open = false;
    pane.root.hidden = true;
    pane.number = 0;
    pane.total = 0;
    pane.searched = false;
    pane.search.clearDecorations();
    pane.term.clearSelection();
    render(pane);
    deps.changed();
    if (focusBack) deps.restoreFocus(pane.id);
  }

  function open(pane: PaneFind): void {
    pane.open = true;
    pane.root.hidden = false;
    pane.input.value = pane.query;
    render(pane);
    pane.input.focus();
    pane.input.select();
    if (hasQuery(pane.query)) run(pane);
    deps.changed();
  }

  function ensure(id: string): PaneFind | null {
    const existing = panes.get(id);
    if (existing) return existing;
    const view = deps.view(id);
    if (!view) return null; // 冷格：没有 Terminal，也就没有可查找的屏幕

    const root = document.createElement("div");
    root.className = "find-bar";
    root.hidden = true;
    root.setAttribute("role", "search");

    const input = document.createElement("input");
    input.className = "find-input";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.autocapitalize = "off";

    const count = document.createElement("span");
    count.className = "find-count";
    count.textContent = "0/0";

    const makeButton = (cls: string, label: string): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = cls;
      button.textContent = label;
      // 点按钮不抢走输入框的焦点：连着点「下一个」时手不用在输入框里重新定位光标
      button.addEventListener("mousedown", (event) => event.preventDefault());
      return button;
    };
    const prevBtn = makeButton("find-prev", "↑");
    const nextBtn = makeButton("find-next", "↓");
    const caseBtn = makeButton("find-case", "Aa");
    const wrapBtn = makeButton("find-wrap", "↻");
    const closeBtn = makeButton("find-close", "✕");

    root.append(input, count, prevBtn, nextBtn, caseBtn, wrapBtn, closeBtn);
    // 挂在终端宿主里：视图搬家、布局重建、销毁时查找条跟着走，不用额外登记生命周期
    view.hostEl.append(root);

    const pane: PaneFind = {
      id,
      term: view.term,
      search: view.search,
      root,
      input,
      count,
      prevBtn,
      nextBtn,
      caseBtn,
      wrapBtn,
      closeBtn,
      disposeResults: () => {},
      open: false,
      query: "",
      number: 0,
      total: 0,
      searched: false,
      inputTimer: undefined,
      edgeTimer: undefined
    };

    const results = pane.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      pane.total = resultCount;
      pane.number = hitNumber(resultIndex, resultCount);
      pane.searched = true;
      render(pane);
    });
    pane.disposeResults = () => results.dispose();

    input.addEventListener("input", () => {
      pane.query = input.value;
      if (pane.inputTimer !== undefined) window.clearTimeout(pane.inputTimer);
      pane.inputTimer = window.setTimeout(() => {
        pane.inputTimer = undefined;
        run(pane);
      }, INPUT_DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return; // 输入法选字时的 Enter / 方向键归输入法
      if (event.key === "Escape") {
        event.preventDefault();
        close(pane, true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        step(pane, event.shiftKey ? -1 : 1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        step(pane, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        step(pane, -1);
      }
    });

    prevBtn.addEventListener("click", () => step(pane, -1));
    nextBtn.addEventListener("click", () => step(pane, 1));
    closeBtn.addEventListener("click", () => close(pane, true));
    caseBtn.addEventListener("click", () => {
      prefs = { ...prefs, caseSensitive: !prefs.caseSensitive };
      savePrefs();
      render(pane);
      restart(pane); // 大小写变了要整屏重来，否则会从上一个命中的位置接着找
      input.focus();
    });
    wrapBtn.addEventListener("click", () => {
      prefs = { ...prefs, wrap: !prefs.wrap };
      savePrefs();
      render(pane);
      input.focus();
    });

    // 点查找条本体不该被当成「点终端」而把焦点交给终端
    root.addEventListener("mousedown", (event) => event.stopPropagation());
    // 焦点进出查找条都会改变「按键归谁」：让输入条的状态点跟着说实话
    root.addEventListener("focusin", () => deps.changed());
    root.addEventListener("focusout", () => deps.changed());

    panes.set(id, pane);
    paintText(pane);
    return pane;
  }

  function active(): PaneFind | null {
    const id = deps.activeId();
    if (!id) return null;
    return panes.get(id) ?? null;
  }

  function syncVisibility(): void {
    const activeId = deps.activeId();
    for (const pane of panes.values()) {
      pane.root.hidden = !pane.open || pane.id !== activeId;
    }
  }

  const handle: FindBarHandle = {
    toggle() {
      const id = deps.activeId();
      if (!id) return;
      const pane = ensure(id);
      if (!pane) return;
      if (pane.open) close(pane, true);
      else open(pane);
    },
    closeFor(id) {
      const pane = panes.get(id);
      if (!pane || !pane.open) return;
      // 清屏是用户显式的「这里清了」：连状态一起丢掉，别让切回来还挂着一屏高亮
      close(pane, false);
      pane.query = "";
      pane.input.value = "";
    },
    forget(id) {
      const pane = panes.get(id);
      if (!pane) return;
      if (pane.inputTimer !== undefined) window.clearTimeout(pane.inputTimer);
      if (pane.edgeTimer !== undefined) window.clearTimeout(pane.edgeTimer);
      pane.disposeResults();
      pane.root.remove();
      panes.delete(id);
      deps.changed();
    },
    setActive() {
      syncVisibility();
    },
    holdsKeys() {
      const pane = active();
      if (!pane || !pane.open) return false;
      const focused = document.activeElement;
      return !!focused && pane.root.contains(focused);
    },
    refreshText() {
      for (const pane of panes.values()) paintText(pane);
    },
    recolor() {
      for (const pane of panes.values()) {
        if (!pane.open || !hasQuery(pane.query)) continue;
        pane.search.clearDecorations();
        pane.search.findNext(pane.query, searchOptions());
      }
    },
    prefs: () => prefs
  };

  onLocaleChange(() => handle.refreshText());
  return handle;
}
