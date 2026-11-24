import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  filterHistory,
  ghostFor,
  localTime,
  withDayAnchors,
  type HistoryItem,
  type HistoryRow
} from "./history";
import {
  applyAppend,
  emptyCache,
  fromSnapshot,
  type HistoryCache,
  type HistorySnapshot
} from "./historyCache";
import { stripFocusReports } from "./ptyInput";
import { ROW_ICON } from "./icons";
import { normalizeHexInput } from "./hexInput";
import { keepAfter, type OutChunk } from "./outQueue";
import { clearDisplayMode } from "./displayClear";
import { setupFilePanel } from "./filePanelUi";
import { setupFindBar } from "./findBarUi";
import { setupShortcutsUi } from "./shortcutsUi";
import { DRAGGING_CLASS } from "./resize";
import { setupInputbarResize } from "./inputbarResize";
import { setupSidebar } from "./sidebarUi";
import { setupSessionDialog, type NewSessionRequest, type PlacementChoice, type TerminalProfile, type SerialConfig } from "./sessionDialogUi";
import { mergeRuntimeStates, type RuntimeState } from "./runtimeState";
import {
  DEFAULT_FONT_SIZE,
  TERMINAL_CURSOR_BLINK,
  TERMINAL_FONT_FAMILY,
  TERMINAL_WEBGL,
  clampFontSize
} from "./displaySettings";
import { applyStaticI18n, initLocale, onLocaleChange, t } from "./i18n";
import { closePopupMenu, showPopupMenu, type PopupItem, type PopupMenuHandle } from "./popupMenu";
import { applyTheme, readTheme, xtermTheme } from "./theme";
import { setupGlobalSettings } from "./globalSettingsUi";
import { setupRightBar } from "./rightBarUi";
import { setupSerialPortsPanel, type SerialPortsPanelHandle } from "./serialPortsPanelUi";
import { setupSessionSettingsUi, type SessionSettings } from "./sessionSettingsUi";
import { setupTitlebar } from "./titlebar";
import { TerminalPool, type TerminalView } from "./terminalViews";
import { clampRatio, neighborOf, paneList, type Direction, type PaneLayout } from "./layoutTree";
import { isProjectOpenCurrent } from "./projectGuard";
import { setupProjectDialog } from "./projectDialogUi";
import { beginPaneDrag, type PaneDropInfo } from "./paneDragUi";
import { decideDrop } from "./paneDrag";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const t0 = performance.now();
const hud = document.getElementById("hud") as HTMLDivElement;
const bar = document.getElementById("inputbar") as HTMLDivElement;
const resizer = document.getElementById("inputbar-resizer") as HTMLDivElement;
const dot = document.getElementById("own-dot") as HTMLSpanElement;
const ownLabel = document.getElementById("own-label") as HTMLSpanElement;
const ib = document.getElementById("ib-input") as HTMLTextAreaElement;
const ibSend = document.getElementById("ib-send") as HTMLButtonElement;
const ibHistory = document.getElementById("ib-history") as HTMLButtonElement;
const ibOverride = document.getElementById("ib-override") as HTMLButtonElement;
const ghostEl = document.getElementById("ib-ghost") as HTMLSpanElement;
const sessList = document.getElementById("sess-list") as HTMLDivElement;
const projNew = document.getElementById("proj-new") as HTMLButtonElement;
const projCollapseAll = document.getElementById("proj-collapse-all") as HTMLButtonElement;
const projExpandAll = document.getElementById("proj-expand-all") as HTMLButtonElement;
const settingsOpenSidebar = document.getElementById("settings-open-sidebar") as HTMLButtonElement;
const histOverlay = document.getElementById("hist-overlay") as HTMLDivElement;
const histQuery = document.getElementById("hist-query") as HTMLInputElement;
const histList = document.getElementById("hist-list") as HTMLDivElement;
const histCount = document.getElementById("hist-count") as HTMLSpanElement;
const histClearBtn = document.getElementById("hist-clear") as HTMLButtonElement;
const histCloseBtn = document.getElementById("hist-close") as HTMLButtonElement;
const ibPaused = document.getElementById("ib-paused") as HTMLSpanElement;
const ibHex = document.getElementById("ib-hex") as HTMLButtonElement;
const ibLog = document.getElementById("ib-log") as HTMLButtonElement;

// 语言与主题在模块求值时就定下来：后面的常量、首帧文案都按它们走
initLocale();
applyTheme(readTheme());

/// HUD 上的诊断消息是瞬时的：显示几秒后自动淡出，免得一条启动信息永远压在终端上。
const HUD_TTL_MS = 6000;
let hudTimer: number | undefined;

function log(msg: string) {
  hud.textContent = msg;
  console.log(msg);
  window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => {
    hud.textContent = "";
  }, HUD_TTL_MS);
}

// ---- 诊断开关：默认关闭 ----
// 定位「切会话响铃 / Ctrl+R 白屏」时，每次按键都会发一条 bench_report，等于在按键热路径上
// 多一次 IPC 往返。问题查清后默认关掉；要看时间线时开 `#debug`（或把 localStorage 里
// `pinshell.debug` 置 1）。
const DEBUG = (() => {
  try {
    return location.hash === "#debug" || localStorage.getItem("pinshell.debug") === "1";
  } catch {
    return false;
  }
})();

function trace(msg: string) {
  if (!DEBUG) return;
  void invoke("bench_report", { text: `[trace] ${msg}` });
}

function countQueries(text: string): number {
  const patterns = ["\x1b[6n", "\x1b[5n", "\x1b[c", "\x1b[>", "\x1b]11;?", "\x1b]4;", "\x1bP$q"];
  return patterns.reduce((n, p) => n + text.split(p).length - 1, 0);
}

/// 快捷键匹配：优先认物理键位（`code`）；没有 `code` 的合成按键（自动化脚本、某些输入法）
/// 退回字符比较。这样两副键盘布局下 Ctrl+R/P/L 都只认字母本身。
function matchesKey(e: KeyboardEvent, code: string, key: string): boolean {
  return e.code === code || (!e.code && e.key.toLowerCase() === key);
}

// ---- 临时诊断（定位「Ctrl+R 第二次白屏」）：给每次模块求值编号，看重载有没有发生 ----
const BOOT_KEY = "pinshell.boots";
let bootNo = 0;
try {
  bootNo = Number(sessionStorage.getItem(BOOT_KEY) ?? "0") + 1;
  sessionStorage.setItem(BOOT_KEY, String(bootNo));
} catch {
  bootNo = -1;
}
trace(`boot #${bootNo} pw=${window.innerWidth}x${window.innerHeight}`);
window.addEventListener("pagehide", () => trace(`pagehide #${bootNo}`));
window.addEventListener("beforeunload", () => trace(`beforeunload #${bootNo}`));
window.addEventListener("error", (e) => trace(`js error #${bootNo} ${e.message}`));
window.addEventListener("unhandledrejection", (e) => trace(`js rejection #${bootNo} ${String(e.reason)}`));

document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
});

/// 终端保留多少行历史（xterm 的 `scrollback`）。其他产品的默认值各不相同：
/// VS Code 1000、tmux / kitty 2000、WezTerm 3500、Windows Terminal 9001、Alacritty 10000、
/// iTerm2 默认不限。上限存在的理由主要是**内存**与**持续裁剪的成本**，不是渲染：
/// WebGL 只画视口那几十行。
///
/// 实测（120 列、Node 里跑 xterm 核心缓冲，只解析不渲染；每个上限单独起进程，8 MB / 129k 行。
/// 复现：`node --expose-gc scripts/bench-scrollback.mjs`，数字与读法见 `docs/bench-m0.md`）：
/// - 每行缓冲约占 0.4 KB：5000 行 ≈ 2.0 MB，10000 行 ≈ 3.8 MB，50000 行 ≈ 18.5 MB；
/// - 持续刷屏的吞吐都在 52–57 MB/s，与上限几乎无关；上限越大，灌满那一段越慢
///   （5000 行 177ms、50000 行 232ms），差异来自分配更多单元格而不是裁剪本身。
///
/// 取 5000：单会话约 2 MB，刷屏时与 1000 行的吞吐差异在噪声内，而比 VS Code 的默认值
/// 能多看 5 倍历史。要更深就改这个数（上限变大只会多占内存，不会拖慢稳态吞吐）。
const SCROLLBACK_LINES = 5000;

/// 视图池：每个会话一套 Terminal，焦点只是其中一个视图。
/// 单例 `term` 在这里退役——分格、切焦点、冷格占位都靠池里的 id 取视图，
/// 任何带 id 的函数都不许退回「读全局焦点终端」。
const pool = new TerminalPool({
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: 1.4,
  cursorBlink: TERMINAL_CURSOR_BLINK,
  scrollback: SCROLLBACK_LINES,
  theme: () => xtermTheme(readTheme()),
  webglEnabled: TERMINAL_WEBGL,
  onData: (id, data) => onViewData(id, data),
  onBell: () => trace("BEL fired in xterm"),
  // 点终端主体（而不是项目树/标题条）时也要切上下文：DOM 焦点落到哪个视图，
  // focusSessionId 就跟过去。相等时直接返回，挡掉 pool.focus() 引起的回环。
  onFocus: (id) => {
    if (id !== focusSessionId) void focusProjectPane(id);
  }
});

/// 焦点终端的唯一出口。**从阶段 1 起就是可空**：空壳项目、冷格占位、
/// 焦点会话还没挂上视图时都没有终端，调用方必须先判空。
function focusTerm(): Terminal | null {
  return focusSessionId ? pool.view(focusSessionId)?.term ?? null : null;
}

/// 当前焦点视图。与 `focusTerm()` 同一口径，但分格容器与尺寸逻辑还要 `hostEl`/`fit`。
function focusView(): TerminalView | null {
  return focusSessionId ? pool.view(focusSessionId) : null;
}

/// 事件落在哪个格子上。分格之后右键复制、拖拽命中都要按节点找视图，不能看焦点。
function viewAt(target: EventTarget | null): TerminalView | null {
  if (!(target instanceof Node)) return null;
  for (const view of pool.all()) {
    if (view.hostEl.contains(target)) return view;
  }
  return null;
}

/// 让一个视图按当前格子尺寸重算行列，尺寸真变了才下发 PTY。
/// 隐藏格不调它：`display:none` 下量到 0，会把错误的 cols/rows 发给 Shell。
function fitView(view: TerminalView): void {
  if (!view.visible || !view.hostEl.isConnected) return;
  const before = `${view.term.cols}x${view.term.rows}`;
  view.fit.fit();
  const after = `${view.term.cols}x${view.term.rows}`;
  if (before !== after) {
    pendingResize.set(view.id, { cols: view.term.cols, rows: view.term.rows });
  }
}

/// 按会话设置设字号。分格模式下每个视图用自己会话的字号，不能只设焦点那一格。
function applySessionFont(id: string) {
  if (!pool.view(id)) return;
  const size = clampFontSize(
    tree.find((session) => session.id === id)?.settings.font_size ?? DEFAULT_FONT_SIZE
  );
  pool.setFontSize(id, size);
}

/// 当前会话的字号。会话设置里改完立即生效（预览值可能还没落盘）。
function applyFontSize(size: number) {
  const view = focusView();
  if (!view) return;
  const next = clampFontSize(size);
  if (view.fontSize === next) return;
  pool.setFontSize(view.id, next);
  invalidateGhostMetrics();
  fitView(view);
  syncSize();
}

/// 主题变了：CSS 变量由 `applyTheme` 换，终端这边换 canvas 配色。
/// 只改 `theme` 不会重绘已有内容，所以对每个可见视图各补一次整屏 refresh。
function applyTermTheme() {
  pool.applyTheme();
  findBar?.recolor();
  invalidateGhostMetrics();
  for (const view of pool.all()) {
    if (!view.visible) continue;
    view.term.refresh(0, view.term.rows - 1);
  }
}

/// 语言切换后重画本文件生成的动态文案。
/// 静态标注（`data-i18n`）由这里统一刷；各模块自己的动态文案通过 `onLocaleChange` 重画，
/// 这里再补上会话树与输入条状态——它们是本文件直接画的。
function refreshChromeText() {
  applyStaticI18n(document);
  invalidateGhostMetrics();
  renderTree();
  renderBarStatus();
}

// 功能栏（右栏）先装配：它决定三个面板的可见性与顺序，全局设置要直接读写它。
// 此时各面板还没恢复自己的折叠状态，`rb-fill` 会在它们的类名变化后被重算一次。
const rightBar = setupRightBar({ layoutChanged: () => syncSize() });

const globalSettings = setupGlobalSettings({
  themeChanged: () => applyTermTheme(),
  rightBar
});

document.getElementById("settings-open")!.addEventListener("click", () => globalSettings.open());
settingsOpenSidebar.addEventListener("click", () => globalSettings.open());

onLocaleChange(() => refreshChromeText());

let focusSessionId = "";

/// 按会话保存的轻量输入条状态。切焦点时先存后取；阶段 2 隐藏项目销毁视图后，
/// 这些状态仍然留着，切回来重建视图时直接恢复（暂停/串口另有各自的事件源校正）。
interface SessionUiState {
  hex: boolean;
  own: Ownership | null;
  notice: string;
  noticeIsError: boolean;
}
const sessionUi = new Map<string, SessionUiState>();

function uiOf(id: string): SessionUiState {
  let state = sessionUi.get(id);
  if (!state) {
    state = { hex: false, own: null, notice: "", noticeIsError: false };
    sessionUi.set(id, state);
  }
  return state;
}

function saveFocusUi(id: string | null) {
  if (!id) return;
  const state = uiOf(id);
  state.hex = hexMode;
  state.own = own;
  state.notice = notice;
  state.noticeIsError = noticeIsError;
}

function loadFocusUi(id: string) {
  const state = uiOf(id);
  hexMode = state.hex;
  own = state.own;
  notice = state.notice;
  noticeIsError = state.noticeIsError;
}
/// 功能栏的句柄：监听器可能先于 setup 收到事件，所以允许为空
let filePanel: ReturnType<typeof setupFilePanel> | null = null;
let sessionSettingsUi: ReturnType<typeof setupSessionSettingsUi> | null = null;
let shortcutsUi: ReturnType<typeof setupShortcutsUi> | null = null;
/// 新建会话的弹窗：按钮在装配前就可能被点到（理论上不会），所以允许为空
let sessionDialog: ReturnType<typeof setupSessionDialog> | null = null;
/// 新建项目 / 项目设置的弹窗
let projectDialog: ReturnType<typeof setupProjectDialog> | null = null;
/// 串口列表面板：只用来推「当前焦点会话占着哪个口」的高亮
let serialPortsPanel: SerialPortsPanelHandle | null = null;
/// 查找条：每分格一条，数据源是前端 xterm 缓冲区（docs/find.md、ADR 0009）
let findBar: ReturnType<typeof setupFindBar> | null = null;
let benchTerm: Terminal | null = null;
let benchScheduled = false;

/// 冷启动计量：只量第一次拉起的会话。页面重载挂回旧会话不算冷启动。
/// 计时从模块求值（t0）开始；首个输出与提示符就绪各自只记一次。
const coldStart = {
  /// 还没拉起过任何会话
  pending: true,
  /// 本次拉起是否参与计量（重载挂回时为 false）
  measuring: false,
  /// 参与计量的那个会话 id：之后新开的会话不参与
  session: "",
  spawnStart: 0,
  spawnReturn: 0,
  firstOutputAt: 0,
  /// 提示符就绪（OSC 133 A）到达前端的时刻。「首字节」不是可输入时刻，见 docs/bench-m0.md
  inputReadyAt: 0
};

interface Caps {
  completion: boolean;
  history: boolean;
  timestamp: boolean;
  alt_screen: boolean;
}

interface SessionInfo {
  id: string;
  title: string;
  state: TermState;
  created_ms: number;
  caps: Caps;
}

interface ReplayPayload {
  id: string;
  seq: number;
  data: string;
  dropped_bytes: number;
}

// 附着协议：先拿回放快照，再把「附着期间到达的实时块」按 seq 去重补上。
// seq 由后端会话内递增，前端只比大小，不做任何业务判断。
//
// 这些状态以前是单例，现在必须按会话拆开：两格同时刷输出时，共用一个 lastSeq
// 会让快的格子把慢的格子需要的块判成「已画过」直接丢掉。
interface ViewOutput {
  attaching: boolean;
  pending: { seq: number; data: string }[];
  lastSeq: number;
  queue: OutChunk[];
  /// 小于等于它的块属于「清屏前」：清屏后即使已经在路上、已经排队，也不再画。
  floor: number;
  timer?: number;
}
const viewOutput = new Map<string, ViewOutput>();

function outputOf(id: string): ViewOutput {
  let state = viewOutput.get(id);
  if (!state) {
    state = { attaching: false, pending: [], lastSeq: 0, queue: [], floor: 0 };
    viewOutput.set(id, state);
  }
  return state;
}

/// 合并后的尺寸下发：一次 ResizeObserver 回调可能改到多个格子，
/// 60ms 内只发一轮 `pty_resize`，避免拖动面板时每个格子各刷一次提示符。
const pendingResize = new Map<string, { cols: number; rows: number }>();
let resizeTimer: number | undefined;
/// 每个会话「已经画到过的最大 seq」。终端查询只有画过才会被应答，
/// 所以这个数就是「答到哪儿了」：附着时交给后端，画过的查询删掉、没画过的交回来。
/// 页面重载会丢掉内存里的值，所以按会话存一份在 sessionStorage 里：重载后照样能分清
/// 「这些查询早答过了」和「这段输出还没人答」。
const ANSWERED_KEY = "pinshell.answered";

function loadAnswered(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(ANSWERED_KEY);
    if (raw) {
      return new Map(Object.entries(JSON.parse(raw) as Record<string, number>));
    }
  } catch {
    // 存不下/读不出就当作场次有效：最坏结果是把已答过的查询再答一遍
  }
  return new Map();
}

const answered = loadAnswered();

function persistAnswered() {
  try {
    sessionStorage.setItem(ANSWERED_KEY, JSON.stringify(Object.fromEntries(answered)));
  } catch {
    // 存不上不影响这次运行
  }
}

/// 画到 seq 为止了：只有画过的查询才会被终端应答。
function noteAnswered(id: string, seq: number) {
  if (!id || seq <= 0) return;
  if (seq > (answered.get(id) ?? 0)) answered.set(id, seq);
}

// 重载前把「答到哪儿」留给下一个自己
window.addEventListener("pagehide", persistAnswered);

/// xterm 6.0 + `@xterm/addon-webgl` 0.19 的一处缝隙：`term.reset()` 会清字形模型和顶点缓冲，
/// 却不清 WebGL 渲染器里缓存的底色矩形；而 `updateBackgrounds()` 只在「模型里有单元格变了」
/// 时才重算。于是切到一个空屏（回放为空、或清过屏的会话还没吐提示符）时，上一会话的选中底色
/// 会原样留在画布上：屏幕空了，那几条蓝块还在，直到新会话吐出第一个字符把模型改回来。
/// 这里按当前模型重算一次底色矩形就算修好：空模型只剩一条整屏底色，多余的老矩形随之丢掉。
/// DOM 渲染器没有这层缓存（取不到 `_rectangleRenderer`），那时就什么都不做。
function resyncBackgrounds(term: Terminal) {
  const renderer = (term as any)._core?._renderService?._renderer?.value;
  const rectangles = renderer?._rectangleRenderer?.value;
  const model = renderer?._model;
  if (!rectangles || !model || typeof rectangles.updateBackgrounds !== "function") return;
  rectangles.updateBackgrounds(model);
}

/// 只把某一个视图的屏幕按回放重画一遍：不动输入草稿、不动历史缓存、不动覆盖层。
/// 「暂停 → 继续」、切会话、重建隐藏项目都用它。
/// 返回 false 表示没画成（没有视图、拉快照失败，或期间该视图又被重建过）。
///
/// **快照为空时不动屏幕**：清屏后回放本来就是空的，`reset` 会把 `clear` 特意留在
/// 首行的提示符一起抹掉，留一块全黑的屏幕。
async function resyncScreen(id: string): Promise<boolean> {
  const view = pool.view(id);
  if (!view) return false;
  // 每视图一个代次：快速 A→B→A 时，先发起的那次回放回来会发现自己过期了，直接丢弃。
  const token = ++view.replayGen;
  const out = outputOf(id);
  // 一次回放是否还有资格改状态/写终端：代次、视图对象、这份输出状态三者都必须是
  // 当初那一份。少任何一条，都可能把过期回放写进已销毁的 Terminal，或清掉新调用的
  // `attaching` 让实时块绕过 pending。
  const current = () =>
    token === view.replayGen &&
    pool.view(id) === view &&
    viewOutput.get(id) === out;
  out.attaching = true;
  out.pending = [];
  dropOutQueue(id);
  // 快照是新的权威屏幕，但「答到哪儿」仍然算数：小于等于它的块早画过（或被清屏丢掉了），
  // 不能让它们再从在途事件里画一遍。
  out.floor = answered.get(id) ?? 0;

  let snap: ReplayPayload;
  try {
    // 画到哪儿就答到哪儿：后端只删「已经答过」的那部分查询
    snap = await invoke<ReplayPayload>("pty_replay", {
      id,
      answeredSeq: answered.get(id) ?? 0
    });
    if (DEBUG) {
      trace(
        `attach ${id.slice(0, 4)} answered=${answered.get(id) ?? 0} snapSeq=${snap.seq} len=${snap.data.length} queries=${countQueries(snap.data)}`
      );
    }
  } catch (err) {
    // 过期的那次失败不能清 attaching：新的 resync 可能正在等快照，
    // 清了会让实时块绕过 pending 直接画上屏，随后又被新回放抹掉，永久丢一段。
    if (current()) out.attaching = false;
    log(`挂回失败: ${String(err)}`);
    return false;
  }
  // 附着途中视图被重建、销毁或输出状态被替换：什么都不碰，attaching 归新的那次调用管
  if (!current()) return false;

  // 先把终端尺寸对准当前格子，再整屏回放。反过来的话（先写快照、再 fit）会触发一次重排，
  // 底部提示符和滚动位置都会被推走。
  fitView(view);
  out.lastSeq = snap.seq;
  const term = view.term;
  if (snap.data) {
    // 快照会整屏重画：先复位，免得新内容叠在旧画面上（半屏重影）
    term.reset();
    // 复位后视口可能还停在上一会话的滚动位置：先贴回底部并清掉「用户正在翻历史」的标记
    term.scrollToBottom();
    term.write(snap.data, () => {
      // 视图可能已经被销毁、又用同一个 id 建了新的（gen 都从 1 开始）：
      // 只认当初那个视图对象与那份输出状态，别往已释放的 terminal 里写。
      if (!current()) return;
      // 回放解析完再贴一次：解析期间或随后的 fit/reflow 都可能把视口带离底部。
      term.scrollToBottom();
      // WebGL 只重画「变脏」的行。整屏回放 + 重排之后强制刷一遍可见区。
      term.refresh(0, term.rows - 1);
      // 底色矩形的缓存也要等解析完再按新模型重算：早一步算的是空屏/半屏。
      resyncBackgrounds(term);
      // 滚动条高度的变化是异步派发的，可能晚于这次解析；再等一拍贴一次。
      window.setTimeout(() => {
        if (current()) term.scrollToBottom();
      }, 80);
    });
    // 这一份画过就等于答过：之后再附着，这部分查询交给后端删掉
    noteAnswered(id, snap.seq);
  } else {
    // 空快照：调用方已经 reset 过，这里把视口贴回尾部
    term.scrollToBottom();
  }
  if (snap.dropped_bytes > 0) {
    console.warn(`[replay] 超出上限丢掉了 ${snap.dropped_bytes} 字节`);
  }

  if (!current()) return false;
  out.attaching = false;
  const queued = out.pending;
  out.pending = [];
  for (const chunk of queued) {
    if (chunk.seq > out.lastSeq) {
      out.lastSeq = chunk.seq;
      noteFirstOutput();
      queueOut(id, chunk.data, chunk.seq);
    }
  }

  fitView(view);
  // 尺寸变化可能触发重排，最后再贴一次底，保证切回来/继续后停在最新一行
  term.scrollToBottom();
  // 空快照不会让模型发生变化，底色缓存得手动重算一次，否则旧矩形会一直画着
  resyncBackgrounds(term);
  // 尺寸变了就让 PTY 跟着变：每发一次 shell 就会收到一次 SIGWINCH、重画一次提示符。
  // 这里立即下发当前尺寸，并取消 60ms 的批量发送：那一发是同一尺寸的重复请求，
  // 会让首帧列宽抖一下。
  if (DEBUG) trace(`resize ${id.slice(0, 4)} ${term.cols}x${term.rows}`);
  pendingResize.delete(id);
  void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
  return true;
}

/// 销毁视图本身：卸载 WebGL、释放 Terminal、清掉这个会话的输出队列。
/// **保留 `sessionUi`**：HEX 这类轻量状态要活过视图销毁与冻结。
///
/// 销毁前先解除显示暂停：离开会话/离开项目时运行时还活着，暂停标记留在后端会让
/// 切回来的会话既没有实时输出、又得手动点继续。串口的「暂停」是物理断开，不能自动重连。
function destroyView(id: string, options: { runtimeAlive?: boolean } = {}) {
  const isSerial = tree.find((session) => session.id === id)?.transport === "serial";
  const pausedNow = id === focusSessionId ? paused : pausedBySession.get(id) ?? false;
  if (pausedNow) {
    pausedBySession.set(id, false);
    if (focusSessionId === id) paused = false;
    if (options.runtimeAlive === true && !isSerial) {
      void invoke("pty_set_paused", { id, paused: false }).catch(() => {});
    }
  }
  pool.dispose(id);
  findBar?.forget(id);
  viewOutput.delete(id);
}

/// 会话被移除时连它的输入条状态一起忘掉。
/// 冻结**不能**走这条：节点还留着，HEX 之类的设置要活过视图销毁。
function forgetSession(id: string) {
  destroyView(id, { runtimeAlive: false });
  sessionUi.delete(id);
  pausedBySession.delete(id);
  serialStatusBySession.delete(id);
}

/// 切焦点的界面状态：输入条形态、HEX、提示、历史缓存、文件面板。
/// **不碰主区布局**：点侧栏会话只换焦点，不能把 2×2 清成单格。
function setFocus(id: string) {
  // 切走前把当前格子的输入条状态存进按会话的表；切回来时再取回
  saveFocusUi(focusSessionId);
  focusSessionId = id;
  // 查找条按分格保留：别的格子的条藏起来，切回这一格再显出来
  findBar?.setActive(id);
  filePanel?.selectSession(id);
  shortcutsUi?.selectSession(id);

  const meta = tree.find((session) => session.id === id);
  // 通道类型决定界面上哪些入口存在（串口没有补全、命令检索与备用屏）。
  serialKind = meta?.transport === "serial";
  // 字号跟着会话走：每个视图用自己会话的设置，不能只设焦点那一格
  applySessionFont(id);
  invalidateGhostMetrics();
  loadFocusUi(id);
  serialStatus = serialStatusBySession.get(id) ?? null;
  window.clearTimeout(noticeTimer);
  if (notice) {
    // 恢复的提示也要有寿命，不能一直挂在输入条上
    noticeTimer = window.setTimeout(() => {
      notice = "";
      renderBarStatus();
    }, 6000);
  }
  ibHex.hidden = !serialKind;
  ibLog.hidden = !serialKind;
  // 「直通 / 接管」按钮对所有会话可见：cmd 这类没有提示符标记的会话永远停在「未知 ·
  // 直通」，输入条被禁用，用户唯一的自救入口就是这个按钮（点一下锁接管）。
  document.getElementById("ib-actions")!.hidden = false;
  ibHex.classList.toggle("on", hexMode);
  ibHex.disabled = false;
  ibLog.disabled = true;
  ib.placeholder = serialKind
    ? hexMode ? t("input.placeholderHex") : t("input.placeholderSerial")
    : t("input.placeholder");
  // 历史覆盖层、输入草稿、↑↓ 游标都属于上一个会话：切走时一起丢掉，
  // 否则旧会话里敲了一半的命令会被回车发到新会话去。
  if (!histOverlay.hidden) closeHistoryOverlay(false, false);
  ib.value = "";
  renderSendAvailability();
  overlayDraft = "";
  histIdx = -1;
  histDraft = "";
  persistAnswered();

  // 历史也属于会话：先丢掉上一个会话的缓存，等快照回来再填（L2-02）
  cache = emptyCache(id);
  onHistoryChanged();
  ghostEl.textContent = "";
  currentGhost = "";
}

/// 焦点会话的运行时收尾：归属、整屏回放、暂停/串口状态、历史与文件面板。
/// 主区挂载由调用方负责（`mountProject` 挂整棵布局）。
/// `replay = false` 用于「多格里只搬焦点」：布局刚由 mountProject 重建过，
/// 再整屏重放一次只会白闪一帧。
async function finishFocus(id: string, replay = true) {
  // 冷格（串口默认就是冷的）没有运行时：不查归属/暂停/串口状态，
  // 否则每个接口都回一条「no session」，还会把错误提示挂到输入条上。
  if (!live.has(id)) {
    own = null;
    ib.disabled = true;
    renderBarStatus();
    renderSendAvailability();
    return;
  }
  const view = pool.view(id);
  // 这个视图可能是上次用过的：先把旧画面清掉。新会话的回放可能是空的，
  // `resyncScreen` 只在有内容可画时才复位，空快照就什么也不动。
  if (view) {
    if (replay) view.term.reset();
    // `reset` 只清字形，不清底色矩形缓存：空屏时没人再触发重算，旧底色会留着
    if (replay) resyncBackgrounds(view.term);
  }
  applySessionFont(id);

  // 输入条的形态决定终端有多高：直通模式下它收成 0 高，终端就多出几行。
  // 这一步必须排在 fit + 回放**之前**——否则 resyncScreen 会按上一个会话的形态 fit，
  // 回放完成后输入条才收起，期间给 PTY 连发两次不同尺寸的 resize。
  try {
    applyOwnership(await invoke<Ownership>("pty_ownership", { id }));
  } catch (err) {
    log(`取归属失败: ${String(err)}`);
  }
  if (focusSessionId !== id) return;

  if (view && replay) {
    const ok = await resyncScreen(id);
    if (!ok || focusSessionId !== id) return;
  }

  if (serialKind) await syncSerial(id);
  else await syncPaused(id);
  void rebuildHistory(id);
  // 面板已在附着开始时按目标会话加载；附着完成后再校正一次 CWD。
  await filePanel?.reload();
}

// 会话树：行来自后端工作区（含冷会话），热/冷对照 pty_list 里的活会话
let tree: TreeSession[] = [];
let live = new Map<string, SessionInfo>();

interface TreeSession {
  id: string;
  title: string;
  transport: "terminal" | "serial";
  shell: string | null;
  cwd: string | null;
  serial: SerialConfig | null;
  settings: SessionSettings;
  /// 归属项目；项目是唯一容器，所以一定有值
  owner: string;
}

interface ProjectNode {
  id: string;
  name: string;
  root: string | null;
  frozen: boolean;
  layout: PaneLayout | null;
}

interface WorkspaceSnapshot {
  sessions: TreeSession[];
  projects: ProjectNode[];
  suspended: string[];
}

interface SpawnPlacement {
  project: string;
  target: string | null;
  placement: PlacementChoice;
  ratio?: number;
}

const PROJECT_KEY = "pinshell.project";
/// 项目行的展开状态：存 id 数组。没有这个键时按「全部展开」处理。
const EXPANDED_KEY = "pinshell.projects.expanded";

function readActiveProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function readExpanded(): Set<string> | null {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : null;
  } catch {
    return null;
  }
}

let activeProjectId: string | null = readActiveProject();
/// 每次切项目 +1。异步拉起回来时对不上就作废，避免旧项目的视图挂进当前主区。
let projectOpenToken = 0;
let projects: ProjectNode[] = [];
/// 本次运行里被用户关掉的格：进项目时跳过，重启清空（后端持有，这里只是副本）
let suspended = new Set<string>();
/// 侧栏里展开过的项目。`null` 表示还没有存过：首次读到项目列表时全部展开。
let expanded: Set<string> | null = readExpanded();

function saveActiveProject() {
  try {
    if (activeProjectId) localStorage.setItem(PROJECT_KEY, activeProjectId);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    // 存不上不影响本次运行
  }
}

function saveExpanded() {
  if (!expanded) return;
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // 同上
  }
}

function isExpanded(projectId: string): boolean {
  return expanded === null || expanded.has(projectId);
}

function currentProject(): ProjectNode | null {
  return projects.find((project) => project.id === activeProjectId) ?? null;
}

function projectLeaves(project: ProjectNode | null): string[] {
  return project?.layout ? paneList(project.layout) : [];
}

const pausedBySession = new Map<string, boolean>();
const pauseStateRevision = new Map<string, number>();
const pauseOperations = new Set<string>();
const serialStatusBySession = new Map<string, SerialStatus>();
const activityUntilBySession = new Map<string, number>();
const activityTimers = new Map<string, number>();
const SESSION_ACTIVITY_MS = 900;

/// `serial:status` 的载荷（串口会话才有）。`status` 三态：
/// open = 端口握在手里；released = 已主动断开（还能「连接」）；
/// failed = 读写出错（拔线、端口被系统收走），同样可以重连。
interface SerialStatus {
  id: string;
  status: "open" | "released" | "failed";
  error: string | null;
  log: string | null;
  paused: boolean;
  summary: string;
  config: SerialConfig;
}

async function refreshTree() {
  const revisions = new Map(pauseStateRevision);
  try {
    const [snapshot, lives, runtimeStates] = await Promise.all([
      invoke<WorkspaceSnapshot>("workspace_snapshot"),
      invoke<SessionInfo[]>("pty_list"),
      invoke<RuntimeState[]>("session_runtime_states")
    ]);
    tree = snapshot.sessions;
    projects = snapshot.projects;
    suspended = new Set(snapshot.suspended);
    // 第一次读到项目列表时把所有项目标成展开；之后按用户的操作走
    if (expanded === null) {
      expanded = new Set(projects.map((project) => project.id));
      saveExpanded();
    } else {
      // 已删除的项目不必继续占着展开记录
      const known = new Set(projects.map((project) => project.id));
      for (const id of [...expanded]) if (!known.has(id)) expanded.delete(id);
    }
    // 视图/会话被移除后，按会话存的轻量状态也要跟着清，否则替换、删项目会留下孤儿
    const known = new Set(tree.map((session) => session.id));
    for (const id of [...sessionUi.keys()]) {
      if (!known.has(id)) sessionUi.delete(id);
    }
    // 记着的项目可能已被删除：这里只清空选择，切到哪个项目由 boot / 删除流程决定
    if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) {
      activeProjectId = projects[0]?.id ?? null;
      saveActiveProject();
    }
    live = new Map(lives.map((s) => [s.id, s]));
    const merged = mergeRuntimeStates(
      { paused: pausedBySession, serial: serialStatusBySession },
      runtimeStates,
      revisions,
      pauseStateRevision,
      new Set(lives.map((s) => s.id))
    );
    pausedBySession.clear();
    serialStatusBySession.clear();
    for (const [id, value] of merged.paused) pausedBySession.set(id, value);
    for (const [id, value] of merged.serial) serialStatusBySession.set(id, value as SerialStatus);
  } catch (err) {
    console.warn(`[tree] ${String(err)}`);
  }
  renderTree();
}

/// 正在改名的会话 id。改名从会话操作菜单进入，回车提交、Esc 放弃。
let renaming: string | null = null;
/// 删除会话的二次确认给多久：超过这个时间菜单上的「确认删除？」自己收回，
/// 免得隔很久再点那一下，手一滑就把会话删了。
const DELETE_CONFIRM_MS = 5000;

function showTerminalSelectionMenu(text: string, x: number, y: number) {
  showPopupMenu(
    { x, y },
    [
      {
        label: t("common.copy"),
        run: () => {
          void navigator.clipboard.writeText(text).catch((error: unknown) => {
            console.warn(`[clipboard] 复制终端选区失败: ${String(error)}`);
          });
        }
      }
    ]
  );
}

/// 右键落在终端选区上时弹「复制」，返回 true 表示这次右键已被处理。
/// 分格后 xterm 挂在 .pane 内：contextmenu 从终端往外冒，.pane 会比 #term-host
/// 先收到事件。所以 .pane 的处理器必须先调这里，否则它自己的 stopPropagation
/// 会把复制菜单截断，只剩「关格 / 移除」——复制选项就是这样丢的。
function tryCopySelectionMenu(event: MouseEvent): boolean {
  // 右键落在哪个格子就复制哪个格子的选区：分格之后不能再看「焦点终端」
  const view = viewAt(event.target);
  if (!view || !view.term.hasSelection()) return false;
  event.preventDefault();
  event.stopPropagation();
  showTerminalSelectionMenu(view.term.getSelection(), event.clientX, event.clientY);
  return true;
}

document.getElementById("term-host")!.addEventListener("contextmenu", tryCopySelectionMenu);

function openSessionSettings(session: TreeSession) {
  void sessionSettingsUi?.open(session.id, session.title, session.transport === "serial");
}

function showSessionMenu(session: TreeSession, x: number, y: number) {
  const isLive = live.has(session.id);
  const serial = session.transport === "serial";
  const cachedStatus = serial ? serialStatusBySession.get(session.id) : undefined;
  const pausedNow = serial
    ? cachedStatus
      ? cachedStatus.paused || cachedStatus.status !== "open"
      : session.id === focusSessionId
        ? !serialStatus || serialStatus.paused || serialStatus.status !== "open"
        : true
    : session.id === focusSessionId ? paused : pausedBySession.get(session.id) ?? false;

  const pauseLabel = (down: boolean) => serial
    ? (down ? t("session.connect") : t("session.disconnect"))
    : (down ? t("session.resume") : t("session.pause"));

  let menu: PopupMenuHandle | null = null;
  /// 菜单还开着才回写：异步查到状态时用户可能已经把它关了
  const stillOpen = () => menu?.element.isConnected === true;

  const pauseItem: PopupItem = {
    label: pauseLabel(pausedNow),
    disabled: !isLive,
    run: () => void togglePauseFor(session.id, session.transport)
  };

  const clearItem: PopupItem = {
    label: t("session.clear"),
    disabled: !isLive,
    run: () => void clearScreenFor(session.id)
  };

  const currentOverride = session.id === focusSessionId ? own?.override ?? "none" : "none";
  const overridePending = isLive && session.id !== focusSessionId;
  /// 点的时候再读：异步查到的所有权会改它
  let overrideMode: OverrideMode = currentOverride;
  const overrideItem: PopupItem = {
    // 与输入条按钮同一口径：文案 = 当前锁定状态（直通亮着 = 正在透传）
    label: overridePending
      ? t("sessionSettings.loading")
      : currentOverride === "passthrough" ? t("session.passthrough") : t("session.takeover"),
    title: currentOverride === "passthrough"
      ? t("input.lockedPassthroughHint")
      : currentOverride === "input_bar" ? t("input.lockedInputHint") : t("input.overrideHint"),
    disabled: !isLive || overridePending,
    run: () => void setOverrideFor(session.id, overrideMode === "passthrough" ? "input_bar" : "passthrough")
  };

  const renameItem: PopupItem = {
    label: t("session.rename"),
    run: () => {
      renaming = session.id;
      renderTree();
    }
  };

  const settingsItem: PopupItem = {
    label: t("session.settings"),
    run: () => openSessionSettings(session)
  };

  /// 重启：结束旧运行时并立即用同一 id 拉起新的。卡住没反应时的一键恢复入口。
  /// 串口会话同样适用（断开端口再重连）。冷会话没有运行时，改从格子的「重新拉起」进入。
  const restartItem: PopupItem = {
    label: t("session.restart"),
    title: t("session.restartHint"),
    disabled: !isLive,
    run: () => void restartSession(session.id)
  };

  /// 冻结：结束进程/端口但保留记录、历史与屏幕，点开会按原参数重新拉起。
  /// 与「删除」是两件事，所以单独一项；冷会话无运行时可结束，禁用。
  const freezeItem: PopupItem = {
    label: t("session.freeze"),
    title: t("session.freezeHint"),
    disabled: !isLive,
    run: () => void freezeSession(session.id)
  };

  // 删除会话是唯一不可撤销的操作：先变成红字问一句，再点一次才真的删。
  // 两次点击之间超时自动收回，避免隔了很久再点那一下误删。
  let armed = false;
  let armTimer: number | undefined;
  const disarm = () => {
    armed = false;
    window.clearTimeout(armTimer);
    deleteItem.label = t("session.delete");
  };
  const deleteItem: PopupItem = {
    label: t("session.delete"),
    danger: true,
    // 冷会话也要能删：它的意义就是「把这条记录去掉」，与是否还在跑无关
    run: () => {
      if (!armed) {
        armed = true;
        deleteItem.label = t("session.deleteConfirm");
        window.clearTimeout(armTimer);
        armTimer = window.setTimeout(() => {
          disarm();
          if (stillOpen()) menu?.repaint();
        }, DELETE_CONFIRM_MS);
        menu?.repaint();
        return "keep-open";
      }
      disarm();
      void removePane(session.id);
      return;
    }
  };

  const items: PopupItem[] = [pauseItem, clearItem, overrideItem, renameItem, settingsItem, restartItem, freezeItem, deleteItem];

  // 后台会话没有本地状态：向它问一次，回来再把标签改对
  if (isLive && session.id !== focusSessionId) {
    const stateCommand = serial ? "serial_status" : "pty_paused";
    void invoke<boolean | SerialStatus>(stateCommand, { id: session.id }).then((state) => {
      if (!stillOpen()) return;
      const down = serial
        ? (state as SerialStatus).paused || (state as SerialStatus).status !== "open"
        : state as boolean;
      pauseItem.label = pauseLabel(down);
      menu?.repaint();
    }).catch(() => {});
    void invoke<Ownership>("pty_ownership", { id: session.id }).then((ownership) => {
      if (!stillOpen()) return;
      overrideMode = ownership.override;
      overrideItem.label = ownership.override === "passthrough" ? t("session.passthrough") : t("session.takeover");
      overrideItem.title = ownership.override === "passthrough"
        ? t("input.lockedPassthroughHint")
        : ownership.override === "input_bar" ? t("input.lockedInputHint") : t("input.overrideHint");
      overrideItem.disabled = false;
      menu?.repaint();
    }).catch(() => {});
  }

  menu = showPopupMenu({ x, y }, items, { minWidth: 132 });
}

function renderTree() {
  sessList.textContent = "";
  renderProjectRows();
  paintProjectButtons();
}

/// 头部三个按钮的可用性：没有展开中的项目时「全部收起」禁用，
/// 全部已展开时「全部展开」禁用。禁用而不是隐藏，位置保持稳定。
function paintProjectButtons() {
  const anyCollapsed = expanded !== null && projects.some((project) => !expanded!.has(project.id));
  const anyExpanded = expanded === null || projects.some((project) => expanded!.has(project.id));
  projCollapseAll.disabled = !anyExpanded;
  projExpandAll.disabled = !anyCollapsed;
}

/// 项目行与展开后的会话行。会话行就是进入某一格的侧栏入口。
function renderProjectRows() {
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "proj-empty";
    empty.textContent = t("project.empty");
    sessList.append(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement("div");
    row.className = "proj-row" + (project.id === activeProjectId ? " active" : "");
    row.dataset.projectId = project.id;
    // 项目身份色：按 id 稳定 hash 到 4 档，同一项目颜色固定，避免每次重排换色
    let tone = 0;
    for (let i = 0; i < project.id.length; i++) tone = (tone * 31 + project.id.charCodeAt(i)) % 4;
    row.dataset.tone = String(tone);
    row.title = project.root ?? project.name;

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "proj-chevron";
    chevron.textContent = isExpanded(project.id) ? "▾" : "▸";
    chevron.setAttribute("aria-label", t("project.expand"));
    chevron.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleProjectRow(project.id);
    });

    const name = document.createElement("span");
    name.className = "proj-name";
    name.textContent = project.name;

    const count = document.createElement("span");
    count.className = "proj-count";
    count.textContent = String(projectLeaves(project).length);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "proj-add";
    add.textContent = "＋";
    add.title = t("project.newSession");
    add.setAttribute("aria-label", `${t("project.newSession")}: ${project.name}`);
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      void openNewSessionDialog(project);
    });

    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "sess-menu-button";
    menu.innerHTML = ROW_ICON.more;
    // 三个点弹出的就是右键那套完整菜单（全部启动 / 项目设置 / 冻结 / 删除），
    // 两个入口一份内容，不另做精简版
    menu.title = t("project.menu");
    menu.setAttribute("aria-label", `${t("project.menu")}: ${project.name}`);
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      const bounds = menu.getBoundingClientRect();
      showProjectMenu(project, bounds.right, bounds.bottom);
    });

    row.append(chevron, name);
    if (project.frozen) {
      const frozen = document.createElement("span");
      frozen.className = "proj-frozen";
      frozen.textContent = "❄";
      frozen.title = t("project.frozen");
      row.append(frozen);
    }
    row.append(count, add, menu);
    // 标题行的单击与双击都只做一件事：展开/收起这个项目。双击的第二下（detail > 1）
    // 不再翻转，否则连点两下等于没点。点行顺带选中该项目，主区始终跟得上。
    row.addEventListener("click", (event) => {
      if (event.detail !== 1) return;
      closePopupMenu();
      if (activeProjectId !== project.id) void selectProject(project.id);
      toggleProjectRow(project.id);
    });
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showProjectMenu(project, event.clientX, event.clientY);
    });
    sessList.append(row);

    if (!isExpanded(project.id)) continue;
    const leaves = projectLeaves(project);
    if (!leaves.length) {
      const hint = document.createElement("div");
      hint.className = "proj-child-empty";
      hint.textContent = t("project.emptyShell");
      sessList.append(hint);
      continue;
    }
    for (const id of leaves) {
      const session = tree.find((item) => item.id === id);
      if (session) buildSessionRow(session);
    }
  }
}

/// 展开/收起单个项目。`expanded` 为 null 时先落成完整集合，再改这一项。
function toggleProjectRow(projectId: string) {
  if (expanded === null) expanded = new Set(projects.map((project) => project.id));
  if (expanded.has(projectId)) expanded.delete(projectId);
  else expanded.add(projectId);
  saveExpanded();
  renderTree();
}

function setAllProjectsExpanded(open: boolean) {
  expanded = open ? new Set(projects.map((project) => project.id)) : new Set();
  saveExpanded();
  renderTree();
}

function buildSessionRow(session: TreeSession) {
    const row = document.createElement("div");
    row.className = "sess-row child" + (focusSessionId === session.id ? " active" : "");
    row.dataset.sessionId = session.id;
    const detail = session.transport === "serial" && session.serial
      ? `${t("sidebar.serial")} ${session.serial.port} · ${session.serial.baud}`
      : session.cwd ?? "";
    row.title = `${session.title} · ${session.id.slice(0, 8)}${detail ? ` · ${detail}` : ""}`;

    const dot = document.createElement("span");
    dot.className = "sess-dot";
    const status = session.transport === "serial"
      ? serialStatusBySession.get(session.id)
      : null;
    const isPaused = session.transport === "serial"
      ? !status || status.paused || status.status !== "open"
      : pausedBySession.get(session.id) ?? false;
    const connected = live.has(session.id) && !isPaused;
    if (connected) dot.classList.add("connected");
    if (connected && (activityUntilBySession.get(session.id) ?? 0) > Date.now()) {
      dot.classList.add("activity");
    }

    // 串口的连接参数单独一格：改名只换名字，端口这行不动。
    // 波特率不进侧栏（会话设置里能看到）；它只留在 tooltip 里，鼠标停一下还能查到。
    const params = session.transport === "serial" && session.serial
      ? session.serial.port
      : "";
    const paramsHint = session.transport === "serial" && session.serial
      ? `${session.serial.port} · ${session.serial.baud}`
      : "";
    let detailEl: HTMLSpanElement | null = null;
    if (params && session.title !== params) {
      detailEl = document.createElement("span");
      detailEl.className = "sess-detail";
      detailEl.textContent = params;
      detailEl.title = paramsHint;
    }

  const state = document.createElement("span");
    state.className = "sess-state";
    if (live.has(session.id)) {
      state.textContent = session.transport === "serial"
        ? status?.status === "failed" ? t("session.failed") : isPaused ? t("session.disconnected") : t("session.connected")
        : isPaused ? t("session.paused") : t("session.running");
      state.classList.add(isPaused ? "paused" : "connected");
      state.title = session.transport === "serial"
        ? `${status?.error ?? (isPaused ? t("session.disconnected") : t("session.connected"))} · ${t("session.doubleClickConnect")}`
        : isPaused ? t("session.pausedHint") : t("session.runningHint");
    }

    const name = document.createElement("span");
    name.className = "sess-name";
    if (renaming === session.id) {
      const input = document.createElement("input");
      input.className = "sess-rename";
      input.value = session.title;
      // 改名规则（去空白、按字符截断、拒绝空）只在核心；这里把原文送过去
      const commit = async (save: boolean) => {
        if (renaming !== session.id) return; // 已经提交过（回车后跟着 blur）
        renaming = null;
        if (save) {
          try {
            await invoke("rename_session", { id: session.id, title: input.value });
          } catch (err) {
            console.warn(`[rename] ${String(err)}`);
          }
          await refreshTree();
        }
        renderTree();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // 别让 Ctrl+Shift+P/L 之类的全局快捷键在这里生效
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          void commit(false);
        }
      });
      input.addEventListener("blur", () => void commit(true));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("dblclick", (e) => e.stopPropagation());
      name.append(input);
      // 先进 DOM 再聚焦，否则焦点会落空
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    } else {
      name.textContent = `${session.title} · ${session.id.slice(0, 4)}`;
      name.title = session.transport === "serial" ? t("session.doubleClickConnect") : t("session.doubleClickPause");
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
      });
    }

    const menuButton = document.createElement("button");
    menuButton.className = "sess-menu-button";
    menuButton.type = "button";
    menuButton.innerHTML = ROW_ICON.more;
    menuButton.title = t("session.menu");
    menuButton.setAttribute("aria-label", t("session.menuOf", { title: session.title }));
    menuButton.addEventListener("click", (e) => {
      e.stopPropagation();
      const bounds = menuButton.getBoundingClientRect();
      showSessionMenu(session, bounds.right, bounds.bottom);
    });

    row.append(dot, name);
    if (detailEl) row.append(detailEl);
    row.append(state, menuButton);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSessionMenu(session, e.clientX, e.clientY);
    });
    row.addEventListener("click", (e) => {
      closePopupMenu();
      const clicks = e.detail;
      if (clicks > 1) {
        if (clicks === 2 && live.has(session.id)) {
          e.preventDefault();
          void togglePauseFor(session.id, session.transport);
        }
        return; // 双击名称仍交给上面的重命名处理器；会话行双击切换状态
      }
      void focusSessionRow(session);
    });
    sessList.append(row);
}

// ---------- 项目：选择、主区分格、落点、关闭/移除 ----------

function projectStats(project: ProjectNode): { terminal: number; serial: number } {
  let terminal = 0;
  let serial = 0;
  for (const id of projectLeaves(project)) {
    const meta = tree.find((session) => session.id === id);
    if (meta?.transport === "serial") serial += 1;
    else terminal += 1;
  }
  return { terminal, serial };
}

/// 选一个项目：记住选择、确保展开、确保主区按它的布局挂好。
async function selectProject(id: string) {
  const project = projects.find((item) => item.id === id);
  if (!project) return;
  activeProjectId = id;
  if (expanded === null) expanded = new Set(projects.map((item) => item.id));
  expanded.add(id);
  saveExpanded();
  saveActiveProject();
  const token = ++projectOpenToken;
  const leaves = projectLeaves(project);
  // 焦点：记得的那一格还在布局里就沿用，否则挑第一格（跳过本次运行关掉的）
  if (!focusSessionId || !leaves.includes(focusSessionId)) {
    focusSessionId = leaves.find((sid) => !suspended.has(sid)) ?? leaves[0] ?? "";
  }
  renderTree();
  await openProject(project, token);
}

/// 打开项目：终端格全部拉起（冻结项目与 suspended 的除外），串口保持冷；
/// 然后把整棵布局挂到主区并恢复焦点。
///
/// 拉起是异步的：每过一个 await 都要确认「还停在同一个项目」。
/// 否则用户在拉起完成前切走，旧回调会把旧项目的视图挂进当前主区、或抢走焦点。
async function openProject(project: ProjectNode, token: number) {
  const stillCurrent = () =>
    isProjectOpenCurrent(token, projectOpenToken, activeProjectId, project.id);
  if (!project.frozen) {
    for (const id of projectLeaves(project)) {
      if (!stillCurrent()) return;
      if (suspended.has(id)) continue;
      const meta = tree.find((session) => session.id === id);
      if (!meta || meta.transport !== "terminal" || live.has(id)) continue;
      try {
        await spawn(id, meta.cwd, meta.shell, {
          project: project.id,
          target: null,
          placement: "fill"
        });
      } catch (err) {
        console.warn(`[project] warm ${id.slice(0, 8)}: ${String(err)}`);
      }
    }
    if (!stillCurrent()) return;
    await refreshTree();
    if (!stillCurrent()) return;
  }
  if (focusSessionId) setFocus(focusSessionId);
  mountProject(project);
  if (focusSessionId) await finishFocus(focusSessionId, false);
  if (!stillCurrent()) return;
  renderTree();
}

/// 离开项目/切项目/布局变化时重建主区。**按差集销毁**：不在新布局里的视图才销毁，
/// 仍留在项目里的格子只搬 hostEl——拖 A 到 B 旁边时 C、D 不该整屏重放或闪一下。
function mountProject(project: ProjectNode) {
  const layoutIds = new Set(project.layout ? paneList(project.layout) : []);
  // 记下仍会保留的视图的文本选区：搬 DOM 之后原样恢复，拖动布局不该把选中的文本弄丢
  const selections = new Map<string, { x: number; y: number; length: number }>();
  for (const view of pool.all()) {
    if (!layoutIds.has(view.id)) {
      destroyView(view.id, { runtimeAlive: true });
      continue;
    }
    const position = view.term.getSelectionPosition();
    if (position) {
      selections.set(view.id, {
        x: position.start.x,
        y: position.start.y,
        length: view.term.getSelection().length
      });
    }
  }

  const host = document.getElementById("term-host") as HTMLElement;
  host.textContent = "";
  if (!project.layout) {
    host.append(emptyProjectState(project));
    return;
  }
  host.append(buildProjectNode(project.layout, []));

  const replays: string[] = [];
  for (const body of host.querySelectorAll<HTMLElement>(".pane-body[data-session]")) {
    const id = body.dataset.session ?? "";
    const meta = tree.find((session) => session.id === id);
    // 串口设备常只发裸 `\n`：让 LF 也回到列首，屏幕才会和日志文件一样分行
    const serial = meta?.transport === "serial";
    if (live.has(id)) {
      const existing = pool.view(id);
      if (existing?.visible) {
        pool.attach(id, body, true, serial);
        applySessionFont(id);
      } else {
        // 新建或从不可见变可见：先挂上、按会话设字号，再放行可见并按回放重建
        pool.attach(id, body, false, serial);
        applySessionFont(id);
        pool.setVisible(id, true);
        replays.push(id);
      }
    } else {
      // 冷格：有残留视图就销毁，再显示占位
      if (pool.view(id)) destroyView(id, { runtimeAlive: false });
      body.append(coldPlaceholder(project, id, meta));
    }
  }
  for (const view of pool.all()) {
    if (view.visible) fitView(view);
  }
  flushResize();
  for (const id of replays) void resyncScreen(id);
  // 只恢复保留下来的视图的选区；新回放/新视图没有选区可恢复
  for (const [id, selection] of selections) {
    if (replays.includes(id)) continue;
    const view = pool.view(id);
    if (view) view.term.select(selection.x, selection.y, selection.length);
  }
}

function emptyProjectState(project: ProjectNode): HTMLElement {
  const box = document.createElement("div");
  box.className = "main-empty";
  const title = document.createElement("div");
  title.className = "main-empty-title";
  title.textContent = project.name;
  const hint = document.createElement("div");
  hint.className = "main-empty-hint";
  hint.textContent = t("project.emptyShell");
  const create = document.createElement("button");
  create.type = "button";
  create.className = "main-empty-action";
  create.textContent = t("project.newSession");
  create.addEventListener("click", () => void openNewSessionDialog(project));
  box.append(title, hint, create);
  return box;
}

/// 一个项目都没有：主区给说明与唯一的动作（新建项目）。
function emptyWorkspaceState(): HTMLElement {
  for (const view of pool.all()) destroyView(view.id, { runtimeAlive: true });
  const host = document.getElementById("term-host") as HTMLElement;
  host.textContent = "";
  const box = document.createElement("div");
  box.className = "main-empty";
  const title = document.createElement("div");
  title.className = "main-empty-title";
  title.textContent = t("project.empty");
  const create = document.createElement("button");
  create.type = "button";
  create.className = "main-empty-action";
  create.textContent = t("project.new");
  create.addEventListener("click", () => projectDialog?.openCreate());
  box.append(title, create);
  host.append(box);
  return box;
}

function buildProjectNode(node: PaneLayout, path: boolean[]): HTMLElement {
  if (node.kind === "leaf") return buildProjectPane(node.session);
  const split = document.createElement("div");
  split.className = `term-split ${node.axis}`;
  const first = buildProjectNode(node.first, [...path, false]);
  const second = buildProjectNode(node.second, [...path, true]);
  first.style.flex = `${node.ratio} 1 0`;
  second.style.flex = `${1 - node.ratio} 1 0`;
  const divider = document.createElement("div");
  divider.className = `pane-divider ${node.axis}`;
  divider.title = t("pane.resize");
  setupDivider(divider, split, first, second, node.axis, node.ratio, path);
  split.append(first, divider, second);
  return split;
}

/// 一个项目格子：可拖的标题条 + 关闭按钮 + 终端/占位主体。
/// 只有标题条能发起拖动，终端区域留给 xterm 自己处理选区。
function buildProjectPane(id: string): HTMLElement {
  const meta = tree.find((session) => session.id === id);
  const pane = document.createElement("div");
  pane.className = "term-pane project-pane";
  pane.dataset.session = id;
  // 焦点格用边框标出来：方向键把焦点搬到冷格时也要看得见焦点在哪
  pane.classList.toggle("focused", focusSessionId === id);

  const head = document.createElement("div");
  head.className = "pane-head";
  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = meta?.title ?? id.slice(0, 8);
  title.title = meta ? `${meta.title} · ${id.slice(0, 8)}` : id;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pane-close";
  close.textContent = "×";
  close.title = t("pane.close");
  close.addEventListener("mousedown", (event) => event.preventDefault());
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    void closePane(id);
  });
  head.append(title, close);
  head.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".pane-close")) return;
    void focusProjectPane(id);
  });
  // 只有标题条能发起拖动：终端区域的拖动要留给 xterm 选区
  head.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest(".pane-close")) return;
    beginPaneDrag(
      event,
      { session: id },
      {
        activate: () => closePopupMenu(),
        drop: (info) => handlePaneDrop(info),
        cancel: () => {}
      }
    );
  });

  const body = document.createElement("div");
  body.className = "pane-body";
  body.dataset.session = id;
  pane.append(head, body);

  pane.addEventListener("contextmenu", (event) => {
    // 有终端选区时优先弹「复制」，别让格子菜单吞掉这次右键
    if (tryCopySelectionMenu(event)) return;
    event.preventDefault();
    event.stopPropagation();
    showPaneMenu(id, event.clientX, event.clientY);
  });
  return pane;
}

/// 分隔条拖动：只改 flex，松手才 fit 一次并落盘比例。
function setupDivider(
  divider: HTMLElement,
  container: HTMLElement,
  first: HTMLElement,
  second: HTMLElement,
  axis: "horizontal" | "vertical",
  ratio: number,
  path: boolean[]
) {
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add(DRAGGING_CLASS);
    const rect = container.getBoundingClientRect();
    const total = axis === "horizontal" ? rect.width : rect.height;
    let next = ratio;
    const move = (ev: PointerEvent) => {
      if (total <= 0) return;
      const position = axis === "horizontal" ? ev.clientX - rect.left : ev.clientY - rect.top;
      next = clampRatio(position / total);
      first.style.flex = `${next} 1 0`;
      second.style.flex = `${1 - next} 1 0`;
    };
    const finish = async () => {
      window.removeEventListener("pointermove", move);
      document.body.classList.remove(DRAGGING_CLASS);
      const project = currentProject();
      if (project) updateRatio(project.layout, path, next);
      scheduleFit();
      if (!project) return;
      try {
        await invoke("project_set_split_ratio", {
          id: project.id,
          path,
          ratio: next
        });
      } catch (err) {
        console.warn(`[project] ratio: ${String(err)}`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => void finish(), { once: true });
    window.addEventListener("pointercancel", () => void finish(), { once: true });
  });
}

/// 内存里的布局比例也一起改：下次重挂主区不该弹回旧值。
function updateRatio(layout: PaneLayout | null, path: boolean[], ratio: number) {
  if (!layout || layout.kind === "leaf") return;
  if (!path.length) {
    layout.ratio = ratio;
    return;
  }
  updateRatio(path[0] ? layout.second : layout.first, path.slice(1), ratio);
}

/// 冷格占位：终端可以「重新拉起」，串口只能「连接」（不自动开端口）。
function coldPlaceholder(
  project: ProjectNode,
  id: string,
  meta: TreeSession | undefined
): HTMLElement {
  const box = document.createElement("div");
  box.className = "pane-cold";
  const title = document.createElement("div");
  title.className = "pane-cold-title";
  title.textContent = meta?.title ?? id.slice(0, 8);
  const detail = document.createElement("div");
  detail.className = "pane-cold-detail";
  if (meta?.transport === "serial" && meta.serial) {
    detail.textContent = `${meta.serial.port} · ${meta.serial.baud} 8N1`;
  } else {
    detail.textContent = suspended.has(id) ? t("pane.suspended") : project.frozen ? t("project.frozen") : t("pane.cold");
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pane-wake";
  button.textContent =
    meta?.transport === "serial" ? t("pane.connect") : t("pane.wake");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void wakePane(id);
  });
  box.append(title, detail, button);
  return box;
}

/// 拉起一个冷格：终端走冷会话重开，串口按记住的配置连（还是冷格就 spawn）。
async function wakePane(id: string) {
  const meta = tree.find((session) => session.id === id);
  if (!meta) return;
  try {
    if (meta.transport === "serial") {
      if (live.has(id)) await invoke("serial_connect", { id });
      else if (meta.serial) {
        await invoke("spawn_serial_session", {
          config: meta.serial,
          sessionId: id,
          project: meta.owner,
          target: null,
          placement: "fill",
          ratio: null,
          title: null
        });
      } else {
        throw new Error(t("pane.noSerialConfig"));
      }
    } else {
      // 带上归属：后端据此判断「冻结项目里点醒一格」，解除冻结并把其余冷格
      // 记进本次运行的 suspended。placement 对已有会话不生效。
      await spawn(id, meta.cwd, meta.shell, {
        project: meta.owner,
        target: null,
        placement: "fill"
      });
    }
    suspended.delete(id);
    await refreshTree();
    const project = currentProject();
    if (project) mountProject(project);
    await focusProjectPane(id);
  } catch (err) {
    showNotice(spawnErrorText(err), true, 8000);
  }
}

/// 焦点格的边框跟着 focusSessionId 走。只切 class，不重挂布局。
function paintProjectFocus() {
  for (const pane of document.querySelectorAll<HTMLElement>(".project-pane")) {
    pane.classList.toggle("focused", pane.dataset.session === focusSessionId);
  }
}

/// 项目栏会话行单击：先确保它所属的项目已经打开在主区，再把焦点搬到这一格。
/// 跨项目时只调 focusProjectPane 会得到一个「焦点 id 在主区没有视图」的悬空状态：
/// 归属、历史、输入条全部按这个 id 查空，表现为会话能选中但什么也输不进去。
async function focusSessionRow(session: TreeSession) {
  if (session.owner !== activeProjectId) {
    await selectProject(session.owner);
  }
  await focusProjectPane(session.id);
  // 点会话行后必须把焦点交给这个会话的输入端。两条现成路径都不保证这一点：
  // 同会话时 focusProjectPane 直接 pool.focus() 把焦点塞进终端 textarea；
  // 换会话时 applyOwnership 只认「焦点在 body/按钮/输入控件」才接管，而此刻
  // 焦点在被点的会话行 div 上，不满足。结果敲键全走终端直通，输入框收不到，
  // 表现就是「切过去了但什么也输不进去」。这里按输入权明确归位。
  if (focusSessionId === session.id && own?.id === session.id && !ib.disabled) {
    ib.focus();
  }
}

/// 焦点搬到某一格：不重挂布局，只更新输入条/归属/历史/面板。
async function focusProjectPane(id: string) {
  if (!id) return;
  if (focusSessionId === id) {
    pool.focus(id);
    paintProjectFocus();
    return;
  }
  setFocus(id);
  renderTree();
  paintProjectFocus();
  if (pool.view(id)) {
    await finishFocus(id, false);
  } else {
    // 冷格没有运行时：输入条禁用，等用户点「重新拉起 / 连接」
    own = null;
    ib.disabled = true;
    renderBarStatus();
    renderSendAvailability();
  }
}

/// 只把某一格换成冷占位，不重挂整棵树：关格后另外几格的位置、尺寸与画面都不动。
function markPaneCold(id: string) {
  const body = document.querySelector<HTMLElement>(
    `.pane-body[data-session="${CSS.escape(id)}"]`
  );
  if (!body) return;
  const project = currentProject();
  if (!project) return;
  body.textContent = "";
  body.append(coldPlaceholder(project, id, tree.find((session) => session.id === id)));
}

/// Ctrl+Alt+方向键的键位映射。H/J/K/L 是给 Intel 驱动占用方向键时的退路。
function directionOfKey(event: KeyboardEvent): Direction | null {
  switch (event.code) {
    case "ArrowLeft":
    case "KeyH":
      return "left";
    case "ArrowRight":
    case "KeyL":
      return "right";
    case "ArrowUp":
    case "KeyK":
      return "up";
    case "ArrowDown":
    case "KeyJ":
      return "down";
    default:
      return null;
  }
}

/// 按几何最近邻搬焦点；边界方向没有邻格时什么都不做。
async function moveFocusDirection(direction: Direction) {
  const project = currentProject();
  if (!project?.layout || !focusSessionId) return;
  const next = neighborOf(project.layout, focusSessionId, direction);
  if (!next) return;
  await focusProjectPane(next);
  pool.focus(next);
}

/// 关格 = 冻结：保留节点、布局、历史与快照，本次运行不再自动拉起这一格。
async function closePane(id: string) {
  try {
    await invoke("pty_freeze", { id });
  } catch (err) {
    showNotice(String(err), true);
    return;
  }
  suspended.add(id);
  destroyView(id, { runtimeAlive: false });
  await refreshTree();
  // 只换这一格：重挂整棵树会让另外三格整屏重放，位置虽不动但会白闪
  markPaneCold(id);
  renderTree();
  if (focusSessionId === id) {
    own = null;
    ib.disabled = true;
    renderBarStatus();
    renderSendAvailability();
  }
}

/// 移除一格：销毁会话、历史与快照，布局折叠。右键菜单里要二次确认。
async function removePane(id: string) {
  try {
    await invoke("pty_close", { id });
  } catch (err) {
    showNotice(String(err), true);
    return;
  }
  forgetSession(id);
  await refreshTree();
  const project = currentProject();
  if (focusSessionId === id) {
    focusSessionId = projectLeaves(project).find((sid) => sid !== id) ?? "";
  }
  renderTree();
  if (project) mountProject(project);
  if (focusSessionId) await focusProjectPane(focusSessionId);
}

function showPaneMenu(id: string, x: number, y: number) {
  let armed = false;
  let handle: PopupMenuHandle | null = null;
  const removeItem: PopupItem = {
    label: t("pane.remove"),
    danger: true,
    run: () => {
      if (!armed) {
        armed = true;
        removeItem.label = t("pane.removeConfirm");
        handle?.repaint();
        return "keep-open";
      }
      void removePane(id);
      return;
    }
  };
  handle = showPopupMenu(
    { x, y },
    [{ label: t("pane.close"), run: () => void closePane(id) }, removeItem],
    { minWidth: 180 }
  );
}

/// 拖拽落点：交换 / 在边缘切一格。拖到任何格子之外不会走到这里（paneDragUi 已当回弹）。
function handlePaneDrop(info: PaneDropInfo) {
  const project = currentProject();
  if (!project) return;
  const decision = decideDrop(info.zone, info.payload.session, info.target);
  if (decision.action === "swap") {
    void swapProjectPanes(info.payload.session, info.target);
    return;
  }
  if (decision.action === "split" && decision.side) {
    void moveProjectPane(info.payload.session, info.target, decision.side);
  }
}

/// 项目里的布局错误对人话：3 层上限要提示「先合并两格」，而不是静静失败。
function paneErrorText(err: unknown): string {
  const text = String(err);
  // 后端移动格返回 TooDeep；spawn 的落点预检返回英文的 depth 描述，两种都要翻
  return text.includes("TooDeep") || text.toLowerCase().includes("depth")
    ? t("pane.tooDeep")
    : text;
}

async function moveProjectPane(
  session: string,
  target: string,
  side: "left" | "right" | "top" | "bottom"
) {
  const project = currentProject();
  if (!project) return;
  try {
    const changed = await invoke<boolean>("project_move_pane", {
      id: project.id,
      session,
      target,
      side,
      ratio: 0.5
    });
    if (!changed) return;
  } catch (err) {
    showNotice(paneErrorText(err), true, 8000);
    return;
  }
  await refreshTree();
  const current = currentProject();
  if (current) mountProject(current);
  renderTree();
  if (focusSessionId) await focusProjectPane(focusSessionId);
}

async function swapProjectPanes(a: string, b: string) {
  const project = currentProject();
  if (!project || a === b) return;
  try {
    await invoke("project_swap_panes", { id: project.id, a, b });
  } catch (err) {
    showNotice(String(err), true, 8000);
    return;
  }
  await refreshTree();
  const current = currentProject();
  if (current) mountProject(current);
  renderTree();
  if (focusSessionId) await focusProjectPane(focusSessionId);
}

function showProjectMenu(project: ProjectNode, x: number, y: number) {
  let armed = false;
  let handle: PopupMenuHandle | null = null;
  const deleteItem: PopupItem = {
    label: t("project.delete"),
    danger: true,
    run: () => {
      if (!armed) {
        armed = true;
        deleteItem.label = t("project.deleteConfirm");
        handle?.repaint();
        return "keep-open";
      }
      void deleteProject(project.id);
      return;
    }
  };
  handle = showPopupMenu(
    { x, y },
    [
      { label: t("project.startAll"), disabled: !project.layout, run: () => void startProject(project.id) },
      { label: t("project.settings"), run: () => projectDialog?.openSettings(project) },
      { label: t("project.freeze"), disabled: !project.layout, run: () => void freezeProject(project.id) },
      deleteItem
    ],
    { minWidth: 190 }
  );
}

/// 冻结项目：结束全部运行时、写快照、保留布局与记录。
/// 视图立即销毁（运行时已经没了），但 `sessionUi` 保留——HEX 之类的设置下次还在。
async function freezeProject(id: string) {
  // 冻结会让所有正在进行的异步拉起/启动作废，避免旧循环继续往后开进程
  projectOpenToken += 1;
  try {
    await invoke("project_freeze", { id });
  } catch (err) {
    showNotice(String(err), true);
    return;
  }
  const before = projects.find((project) => project.id === id) ?? null;
  // 只销毁这个项目的视图；项目 A 的视图与主区不在这个列表里
  for (const leaf of projectLeaves(before)) {
    destroyView(leaf, { runtimeAlive: false });
  }
  await refreshTree();
  renderTree();
  // 只有冻结的是当前查看的项目，才动主区与输入条；否则仅刷新侧栏状态
  if (activeProjectId !== id) return;
  const project = currentProject();
  if (project) mountProject(project);
  // 冻结后焦点格也是冷的：输入条没有可发送的对象
  own = null;
  ib.disabled = true;
  renderBarStatus();
  renderSendAvailability();
}

/// 「全部启动」：只拉起终端格，串口保持冷；同时清掉本次运行对该项目的 suspended。
async function startProject(id: string) {
  // 共用 projectOpenToken：不主动递增（免得取消另一个项目正在进行的打开），
  // 但切项目/冻结/删除会让它变化，旧循环在下一个 await 后自己停下。
  const token = projectOpenToken;
  let leaves: string[] = [];
  try {
    leaves = await invoke<string[]>("project_start_all", { id });
  } catch (err) {
    showNotice(String(err), true);
    return;
  }
  if (token !== projectOpenToken) return;
  await refreshTree();
  if (token !== projectOpenToken) return;
  const project = projects.find((item) => item.id === id);
  if (!project) return;
  for (const sid of leaves) {
    if (token !== projectOpenToken) return;
    // 后端已经过滤过活着的格；这里再挡一次，避免前端 live 快照过期导致重复 spawn
    if (live.has(sid)) continue;
    const meta = tree.find((session) => session.id === sid);
    if (!meta) continue;
    try {
      await spawn(sid, meta.cwd, meta.shell, {
        project: id,
        target: null,
        placement: "fill"
      });
    } catch (err) {
      console.warn(`[project] start ${sid.slice(0, 8)}: ${String(err)}`);
    }
  }
  await refreshTree();
  if (token !== projectOpenToken) return;
  // 非当前项目只在后台拉起进程：不挂主区、不动焦点
  if (activeProjectId !== id) return;
  const current = currentProject();
  if (!current) return;
  focusSessionId = leaves.find((sid) => live.has(sid)) ?? focusSessionId;
  if (focusSessionId) {
    setFocus(focusSessionId);
    mountProject(current);
    await finishFocus(focusSessionId, false);
  } else {
    mountProject(current);
  }
  renderTree();
}

async function deleteProject(id: string) {
  // 删项目同样会让正在进行的异步拉起/启动作废
  projectOpenToken += 1;
  let removed: string[] = [];
  try {
    removed = await invoke<string[]>("project_delete", { id });
  } catch (err) {
    showNotice(String(err), true);
    return;
  }
  for (const session of removed) forgetSession(session);
  const wasActive = activeProjectId === id;
  const next = wasActive ? projects.find((project) => project.id !== id) ?? null : null;
  if (wasActive) {
    activeProjectId = next?.id ?? null;
    focusSessionId = "";
    saveActiveProject();
  }
  if (expanded) expanded.delete(id);
  saveExpanded();
  await refreshTree();
  renderTree();
  if (activeProjectId) {
    const project = currentProject();
    if (project) await selectProject(project.id);
  } else {
    emptyWorkspaceState();
  }
}

/// 结构化错误 → 人话。串口占用要带上「哪个项目的哪个会话」。
function spawnErrorText(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const detail = err as {
      kind: string;
      port?: string;
      project?: string;
      session?: string;
      message?: string;
    };
    if (detail.kind === "port_busy") {
      return t("project.portBusy", {
        port: detail.port ?? "",
        session: detail.session ?? "",
        project: detail.project ?? ""
      });
    }
    if (detail.kind === "message" && detail.message) return detail.message;
  }
  return typeof err === "string" ? err : String(err);
}

/// 落点 → 目标格。`fill` 用于空项目（target 必须为空）；其余落点贴着焦点格。
function placementTarget(project: ProjectNode, choice: PlacementChoice): string | null {
  if (choice === "fill") return null;
  const leaves = projectLeaves(project);
  return leaves.includes(focusSessionId) ? focusSessionId : leaves[0] ?? null;
}

/// 打开新建会话弹窗：先切到目标项目，再按「是否已有格子」决定落点字段。
async function openNewSessionDialog(project: ProjectNode) {
  if (!sessionDialog) return;
  if (project.id !== activeProjectId) await selectProject(project.id);
  await sessionDialog.open({ hasPanes: project.layout !== null });
}

// ---------- 新建会话 ----------

/// 新建会话弹窗的回调：真正创建，然后把项目、主区与焦点一起搬过去。
/// 失败原样抛回弹窗（端口被占、目录不存在、深度超限），由弹窗显示。
async function createSessionFromDialog(request: NewSessionRequest): Promise<void> {
  const project = currentProject();
  if (!project) throw new Error(t("project.empty"));
  const placement: SpawnPlacement = {
    project: project.id,
    target: placementTarget(project, request.placement),
    placement: request.placement,
    ratio: 0.5
  };
  let id: string;
  try {
    if (request.transport === "serial") {
      if (!request.serial) throw new Error("missing serial config");
      id = await newSerialSession(request.serial, placement, request.title || null);
    } else {
      id = await spawn(
        null,
        request.cwd,
        request.shell,
        placement,
        request.title || null
      );
    }
  } catch (err) {
    throw new Error(spawnErrorText(err));
  }
  await refreshTree();
  suspended.delete(id);
  setFocus(id);
  if (expanded === null) expanded = new Set(projects.map((item) => item.id));
  expanded.add(project.id);
  saveActiveProject();
  saveExpanded();
  renderTree();
  const current = currentProject() ?? project;
  mountProject(current);
  await finishFocus(id, false);
}

function markSessionActivity(id: string) {  const session = tree.find((item) => item.id === id);
  if (!session || !live.has(id)) return;
  const connected = session.transport === "serial"
    ? (() => {
        const status = serialStatusBySession.get(id);
        return !!status && !status.paused && status.status === "open";
      })()
    : !(pausedBySession.get(id) ?? false);
  if (!connected) return;

  // 边沿触发：活跃窗口已经开着就只顺延截止时间（纯内存 O(1)），不查 DOM、不动定时器——
  // 刷屏时每块输出都走到这里，之前每块都做两次 querySelectorAll 全表扫描。
  if (activityTimers.has(id)) {
    activityUntilBySession.set(id, Date.now() + SESSION_ACTIVITY_MS);
    return;
  }

  // 静默 → 活跃：亮灯一次，起一个跟随截止时间的定时器。到期时若截止时间被后续输出
  // 顺延过就按剩余时间续期，真正到期才灭灯。renderTree 重建也会按 Map 里的截止时间
  // 把活跃窗口内的点重新亮上（见 renderTree 的 activity 分支），两边不会打架。
  activityUntilBySession.set(id, Date.now() + SESSION_ACTIVITY_MS);
  const dotEl = () =>
    sessList.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(id)}"] .sess-dot`
    );
  dotEl()?.classList.add("activity");
  const arm = (ms: number) => {
    activityTimers.set(id, window.setTimeout(() => {
      const remaining = (activityUntilBySession.get(id) ?? 0) - Date.now();
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      activityUntilBySession.delete(id);
      activityTimers.delete(id);
      dotEl()?.classList.remove("activity");
    }, ms));
  };
  arm(SESSION_ACTIVITY_MS);
}

/// Shell profile 列表来自核心（`terminal_profiles`），弹窗本身不猜默认值。
async function loadShellProfiles(): Promise<TerminalProfile[]> {
  try {
    return await invoke<TerminalProfile[]>("terminal_profiles");
  } catch (err) {
    console.warn(`[terminal-profiles] ${String(err)}`);
    return [];
  }
}

/// 第一次拉起的会话才量冷启动；之后新开的会话不重写这组数字。
/// `title` 只在新建时生效（冷会话重开不覆盖用户改过的名字）。
async function spawn(
  id: string | null,
  cwd: string | null,
  shell: string | null,
  placement: SpawnPlacement,
  title: string | null = null
): Promise<string> {
  const first = coldStart.pending;
  if (first) {
    coldStart.pending = false;
    coldStart.measuring = true;
    coldStart.spawnStart = performance.now();
  }
  let spawned: string;
  try {
    const term = focusTerm();
    spawned = await invoke<string>("spawn_session", {
      cols: term?.cols ?? 80,
      rows: term?.rows ?? 24,
      shell,
      cwd,
      sessionId: id,
      project: placement.project,
      target: placement.target,
      placement: placement.placement,
      ratio: placement.ratio ?? null,
      title
    });
  } catch (err) {
    // 本次没拉起成功：把计量状态还回去，让重试仍然算冷启动
    if (first) {
      coldStart.pending = true;
      coldStart.measuring = false;
    }
    throw err;
  }
  if (first) {
    coldStart.session = spawned;
    coldStart.spawnReturn = performance.now();
    log(
      `bench: 前端就绪 ${Math.round(coldStart.spawnStart - t0)}ms · spawn 调用 ${Math.round(coldStart.spawnReturn - coldStart.spawnStart)}ms`
    );
  }
  return spawned;
}

/// 新建串口会话。参数来自弹窗，错误一路抛回去让弹窗显示（端口被占用、
/// 设备不在、波特率越界……），不在这里吞掉。成功返回会话 id，挂载交给调用方。
async function newSerialSession(
  config: SerialConfig,
  placement: SpawnPlacement,
  title: string | null
): Promise<string> {
  const id = await invoke<string>("spawn_serial_session", {
    config,
    sessionId: null,
    project: placement.project,
    target: placement.target,
    placement: placement.placement,
    ratio: placement.ratio ?? null,
    title
  });
  return id;
}

/// 冻结会话：结束运行时（终端进程 / 串口句柄）但保留工作区节点、命令历史与屏幕快照。
/// 点这一行会按原参数重新拉起，和冷会话的恢复路径完全一样。
async function freezeSession(id: string) {
  try {
    await invoke("pty_freeze", { id });
  } catch (err) {
    console.warn(`[freeze] ${String(err)}`);
    return;
  }
  // 冻结保留节点，但运行时没了：视图立即销毁，切回来按快照重建。
  // 只销毁视图、不删 SessionUiState——HEX 这类设置要活过冻结。
  await refreshTree();
  destroyView(id, { runtimeAlive: false });
  // 格子留在原位变冷占位，不算「关闭会话」，也不切走布局
  suspended.add(id);
  markPaneCold(id);
  renderTree();
  if (focusSessionId === id) {
    own = null;
    ib.disabled = true;
    renderBarStatus();
    renderSendAvailability();
  }
}

/// 重启会话运行时：结束旧进程后立即用同一 id 拉起新的，记录/历史/屏幕快照都保留。
/// 用于 ConPTY 偶发僵死（进程还在、写能进、但不再吐输出，ownership 卡在 running）——
/// 这种情况「暂停/继续」只翻标志位救不回来，必须重建 ConPTY 通道。
async function restartSession(id: string) {
  const meta = tree.find((session) => session.id === id);
  if (!meta) return;
  try {
    await invoke("pty_freeze", { id });
  } catch (err) {
    console.warn(`[restart] freeze failed: ${String(err)}`);
  }
  // 旧运行时已结束：即使 freeze 报错也按僵死处理，避免把死通道又当成活的。
  live.delete(id);
  destroyView(id, { runtimeAlive: false });
  suspended.delete(id);
  try {
    await spawn(id, meta.cwd, meta.shell, {
      project: meta.owner,
      target: null,
      placement: "fill"
    });
    await refreshTree();
    const project = currentProject();
    if (project) mountProject(project);
    await focusProjectPane(id);
  } catch (err) {
    showNotice(spawnErrorText(err), true, 8000);
  }
}

async function boot() {
  await refreshTree();
  // 回到上次选中的项目；没有项目就显示空状态，由用户点「新建项目」
  const project = currentProject() ?? projects[0] ?? null;
  if (!project) {
    emptyWorkspaceState();
    return;
  }
  await selectProject(project.id);
  log(`项目 ${project.name} · ${projectLeaves(project).length} 格`);
}

projNew.addEventListener("click", () => projectDialog?.openCreate());
projCollapseAll.addEventListener("click", () => setAllProjectsExpanded(false));
projExpandAll.addEventListener("click", () => setAllProjectsExpanded(true));

/// 每个视图自己的按键出口。xterm 的 onData 里既有真按键，也有终端回报：
/// 焦点报告（`ESC[I` / `ESC[O`）不是用户输入，原样写进 PTY 会被 PSReadLine 当成按键
/// （响一声、还可能整屏重画）。摘法见 ptyInput.ts。
function onViewData(id: string, data: string) {
  const typed = stripFocusReports(data);
  if (!typed) return;
  trace(`send ${id.slice(0, 4)} ${JSON.stringify(typed)}`);
  void invoke("pty_write", { id, data: typed });
}

/// 布局变化后同步尺寸。回调可能一帧内来很多次（拖窗口、折叠面板、改输入条高度），
/// 合并成一次 rAF：先 fit 所有可见视图，再 60ms 后统一下发真正变了的尺寸。
function syncSize() {
  if (document.body.classList.contains(DRAGGING_CLASS)) return;
  scheduleFit();
}

let fitFrame: number | undefined;
function scheduleFit() {
  if (fitFrame !== undefined) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = undefined;
    for (const view of pool.all()) {
      if (view.visible) fitView(view);
    }
    scheduleResizeFlush();
  });
}

function scheduleResizeFlush() {
  if (!pendingResize.size) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(flushResize, 60);
}

function flushResize() {
  window.clearTimeout(resizeTimer);
  resizeTimer = undefined;
  const pending = [...pendingResize];
  pendingResize.clear();
  for (const [id, size] of pending) {
    void invoke("pty_resize", { id, cols: size.cols, rows: size.rows });
  }
}

// 终端容器尺寸一变就让画布跟上：拖窗口、折叠面板都会走这里。
// WebGL 画布是独立合成层，晚一帧就会把旧尺寸的画面画到旁边；ResizeObserver 在布局后、
// 绘制前触发，正好补上这个空档，也比在每个改布局的地方各挂一次 fit 更不容易漏。
new ResizeObserver(() => syncSize()).observe(document.getElementById("term-host") as HTMLElement);

window.addEventListener("resize", () => {
  invalidateGhostMetrics();
  syncSize();
});

// ---------- 输入所有权：裁定在 Rust，前端只按结果切换焦点 ----------
type Owner = "input_bar" | "channel";
type Confidence = "certain" | "guess";
type TermState = "unknown" | "prompt_guess" | "prompt_ready" | "running" | "alt_screen";
type OverrideMode = "none" | "input_bar" | "passthrough";

interface Ownership {
  id: string;
  owner: Owner;
  confidence: Confidence;
  state: TermState;
  override: OverrideMode;
}

let own: Ownership | null = null;

// ---------- 命令历史：后端是唯一真源，前端只持有当前会话的只读热缓存 ----------
// 契约（L2-02）：附着取 history_snapshot，之后收 history:append；检测到缺口或重连
// 就整份重建，不逐条修补。缓存只服务 Ghost Text 与 ↑↓，写入与全量检索都在核心。
// 判定在 `historyCache.ts`（纯函数，vitest 覆盖），这里只负责接线与渲染。
let cache: HistoryCache = emptyCache("");
let hist: string[] = [];
let histIdx = -1;
let histDraft = "";
/// 每次重建发一个号：在途的旧快照回来后发现号变了就丢掉，免得旧结果盖住新结果
let rebuildSeq = 0;

function onHistoryChanged() {
  syncHistoryNav();
  if (!histOverlay.hidden) renderLocalHistory();
  updateGhost();
}

async function rebuildHistory(id: string) {
  const token = ++rebuildSeq;
  try {
    const snap = await invoke<HistorySnapshot>("history_snapshot", { id });
    if (focusSessionId !== id || token !== rebuildSeq) return; // 附着途中又切走了 / 已有更新的一份
    cache = fromSnapshot(snap);
  } catch (err) {
    console.warn(`[history] ${String(err)}`);
    if (focusSessionId !== id || token !== rebuildSeq) return;
    cache = emptyCache(id); // 留空但认下会话：之后每条追加都会再触发一次重建
  }
  onHistoryChanged();
}

/// ↑↓ 只用缓存里的最近 5000 条（后端快照就是 5000 条窗口）
function syncHistoryNav() {
  hist = cache.items.map((entry) => entry.command);
  histIdx = -1;
  histDraft = "";
}

// ---------- Ghost Text：只做建议，不改变输入内容，直到 → 被按下 ----------
const ghostRuler = document.createElement("canvas").getContext("2d");
let currentGhost = "";
/// 输入法正在组合（拼音选字）：这段时间既不画建议，也不响应 → 与 Enter
let composing = false;

/// ib 的字体度量缓存：`#ib-input` 是 `font: inherit`，运行时近乎恒定。
/// 每键 `getComputedStyle` 会触发强制样式重算（打字热路径上最贵的一笔），
/// 缓存后只在真正会改字体的时机失效重算（见下方各失效点）。
/// `ghostRuler` 仅服务 Ghost Text，字体命中时无需重赋。
let ghostMetrics: { font: string; paddingLeft: string } | null = null;

/// 字体/度量可能变化的时机（字号、主题、语言、窗口尺寸、输入条高度）统一清缓存。
/// 下一次 `updateGhost` 未命中时重算一次，其余打字键全部走缓存。
function invalidateGhostMetrics() {
  ghostMetrics = null;
}

function updateGhost() {
  // 组合期间输入框里是拼音而不是命令：留着上一条建议会看着像已经匹配了
  if (composing) {
    currentGhost = "";
    ghostEl.textContent = "";
    return;
  }
  // 串口没有「命令」可补全（caps.completion = false），也就不画 Ghost Text
  if (serialKind) {
    currentGhost = "";
    ghostEl.textContent = "";
    return;
  }
  const value = ib.value;
  const atEnd = ib.selectionStart === value.length && ib.selectionEnd === value.length;
  const focused = document.activeElement === ib && !ib.disabled && histOverlay.hidden;
  const suggestion = focused && atEnd ? ghostFor(cache.items, value, true) : null;
  if (!suggestion) {
    currentGhost = "";
    ghostEl.textContent = "";
    return;
  }
  currentGhost = suggestion.slice(value.length);
  ghostEl.textContent = currentGhost;
  if (ghostRuler) {
    let metrics = ghostMetrics;
    if (!metrics) {
      // 缓存未命中才做一次强制样式重算：这就是打字路径上省掉的那笔
      const cs = getComputedStyle(ib);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      metrics = { font, paddingLeft: cs.paddingLeft || "0" };
      ghostMetrics = metrics;
      ghostRuler.font = font;
    }
    const width = ghostRuler.measureText(value).width;
    // 长命令会把输入框滚起来：建议要跟着可见文本的末端走，不能按逻辑行首定位
    ghostEl.style.left = `${ib.offsetLeft + parseFloat(metrics.paddingLeft) + width - ib.scrollLeft}px`;
  }
}

// ---------- Ctrl+R：输入条上方的历史检索覆盖层 ----------
// 先本地过滤 5000 条，40 ms 防抖后向核心查全量；Enter 只填充不发送，Esc 恢复草稿。
const HISTORY_RENDER_MAX = 200;
let historyRows: HistoryRow[] = [];
let historyRowEls: HTMLDivElement[] = [];
let historySel = -1;
let overlayDraft = "";
let searchTimer: number | undefined;
let searchToken = 0;
let clearArmed = false;
let clearTimer: number | undefined;

function renderHistoryRows(rows: HistoryRow[], total: number) {
  historyRows = rows;
  historyRowEls = [];
  histList.textContent = "";
  histCount.textContent = total > rows.length
    ? t("history.countCapped", { n: total, m: rows.length })
    : t("history.count", { n: total });
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "hist-empty";
    empty.textContent = t("history.empty");
    histList.append(empty);
    return;
  }

  const cached = new Set(cache.items.map((entry) => entry.id));
  rows.forEach((row, index) => {
    if (row.anchor) {
      const day = document.createElement("div");
      day.className = "hist-day";
      day.textContent = row.anchor;
      histList.append(day);
    }
    const el = document.createElement("div");
    el.className = "hist-row" + (index === historySel ? " sel" : "");
    el.title = row.item.command;

    const cmd = document.createElement("span");
    cmd.className = "hist-cmd";
    cmd.textContent = row.item.command;

    el.append(cmd);
    if (!cached.has(row.item.id)) {
      const older = document.createElement("span");
      older.className = "hist-older";
      older.textContent = t("history.older");
      el.append(older);
    }
    if (row.item.use_count > 1) {
      const badge = document.createElement("span");
      badge.className = "hist-badge";
      badge.textContent = `×${row.item.use_count}`;
      el.append(badge);
    }
    const time = document.createElement("span");
    time.className = "hist-time";
    time.textContent = localTime(row.item.used_ms);
    el.append(time);

    el.addEventListener("mousedown", (event) => {
      event.preventDefault(); // 别把焦点从检索框抢走再触发 blur
      historySel = index;
      acceptHistory();
    });
    historyRowEls.push(el);
    histList.append(el);
  });

  applyHistorySelection();
}

function renderLocalHistory() {
  const all = filterHistory(cache.items, histQuery.value);
  renderHistoryRows(withDayAnchors(all.slice(0, HISTORY_RENDER_MAX)), all.length);
}

function applyHistorySelection() {
  historyRowEls.forEach((el, index) => {
    el.classList.toggle("sel", index === historySel);
  });
  const selected = historyRowEls[historySel];
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function moveHistorySelection(delta: number) {
  if (!historyRows.length) return;
  if (historySel < 0) {
    historySel = delta > 0 ? 0 : historyRows.length - 1;
  } else {
    historySel = (historySel + delta + historyRows.length) % historyRows.length;
  }
  applyHistorySelection();
}

/// 命令片段的「填充」出口：只放进输入条，不发送、不写历史。
function fillInputBar(text: string) {
  ib.value = text;
  const end = text.length;
  ib.setSelectionRange(end, end);
  histIdx = -1; // 填进来的这条不算 ↑↓ 导航的起点
  histDraft = "";
  renderSendAvailability();
  updateGhost();
  if (!ib.disabled) ib.focus();
}

/// Enter / 点击一行：只填充输入条，不发送。
function acceptHistory() {
  const row = historyRows[historySel];
  if (!row) return;
  closeHistoryOverlay(false);
  fillInputBar(row.item.command);
}

function openHistoryOverlay() {
  trace(`overlay open attempt hidden=${histOverlay.hidden ? 1 : 0} session=${focusSessionId ? 1 : 0}`);
  if (!focusSessionId || !histOverlay.hidden) return;
  overlayDraft = ib.value;
  histOverlay.hidden = false;
  trace(`overlay opened hidden=${histOverlay.hidden ? 1 : 0}`);
  histQuery.value = "";
  historySel = -1;
  ghostEl.textContent = "";
  currentGhost = "";
  renderLocalHistory();
  histQuery.focus();
  // 打开时取一次全量：超过本地 5000 条的记录会带上「更早」标记
  const token = ++searchToken;
  void runFullSearch(token);
}

/**
 * 关掉覆盖层。`restoreDraft` 为真时把打开前的草稿放回输入条；
 * `focusInput` 为假时不动焦点（切会话/切权限的自动关闭，焦点另有去处）。
 */
function closeHistoryOverlay(restoreDraft: boolean, focusInput = true) {
  trace(`overlay close hidden=${histOverlay.hidden ? 1 : 0} restore=${restoreDraft ? 1 : 0}`);
  if (histOverlay.hidden) return;
  histOverlay.hidden = true;
  window.clearTimeout(searchTimer);
  searchToken++; // 让在途的检索结果作废
  historySel = -1;
  if (restoreDraft) {
    ib.value = overlayDraft;
  }
  if (!focusInput) return;
  ib.focus();
  const end = ib.value.length;
  ib.setSelectionRange(end, end);
  updateGhost();
}

async function runFullSearch(token: number) {
  const id = focusSessionId;
  if (!id || histOverlay.hidden || token !== searchToken) return;
  try {
    const hits = await invoke<HistoryItem[]>("history_search", { id, query: histQuery.value });
    if (histOverlay.hidden || token !== searchToken || focusSessionId !== id) return;
    historySel = -1;
    renderHistoryRows(withDayAnchors(hits.slice(0, HISTORY_RENDER_MAX)), hits.length);
  } catch (err) {
    console.warn(`[history] search: ${String(err)}`);
  }
}

histQuery.addEventListener("input", () => {
  historySel = -1;
  renderLocalHistory(); // 先在本地 5000 条里出结果，不等 IPC
  window.clearTimeout(searchTimer);
  const token = ++searchToken;
  searchTimer = window.setTimeout(() => void runFullSearch(token), 40);
});

// 覆盖层里的按键统一在这里处理：搜索框、清空/关闭按钮、列表行共用一套。
// 点了按钮之后焦点不在搜索框上，Esc 与 ↑↓ 仍然要能用。
histOverlay.addEventListener("keydown", (e) => {
  if (e.isComposing) return; // 输入法选字时的 Enter / ↑↓ 归输入法
  const onButton = (e.target as HTMLElement | null)?.tagName === "BUTTON";
  if (e.key === "Escape") {
    e.preventDefault();
    closeHistoryOverlay(true);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveHistorySelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveHistorySelection(-1);
  } else if (e.key === "Enter") {
    if (onButton) return; // 让按钮自己响应 Enter
    e.preventDefault();
    acceptHistory();
  } else if (e.key === "Tab") {
    e.preventDefault();
  }
});

histCloseBtn.addEventListener("click", () => closeHistoryOverlay(true));

// 清空只作用当前会话：两段式确认，不弹原生对话框
histClearBtn.addEventListener("click", () => {
  if (!clearArmed) {
    clearArmed = true;
    histClearBtn.classList.add("armed");
    histClearBtn.textContent = t("history.clearArmed");
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearArmed = false;
      histClearBtn.classList.remove("armed");
      histClearBtn.textContent = t("history.clear");
    }, 3000);
    return;
  }
  clearArmed = false;
  window.clearTimeout(clearTimer);
  histClearBtn.classList.remove("armed");
  histClearBtn.textContent = t("history.clear");
  const id = focusSessionId;
  if (!id) return;
  void invoke("history_clear", { id }).then(() => {
    void rebuildHistory(id);
    // 点完按钮焦点留在按钮上，不还给搜索框的话接下来的 ↑↓ 和检索都没反应
    if (!histOverlay.hidden) histQuery.focus();
  });
});

histOverlay.addEventListener("mousedown", (e) => e.stopPropagation());

/// 焦点正被别的界面占用时，所有权变化不该抢回来：模态对话框、历史检索面板与查找条都算。
function blocksOwnershipFocus(): boolean {
  if (!histOverlay.hidden) return true;
  // 查找条在直通模式下也会被打开：它拿焦点期间，按键确实不进通道，别被抢走
  if (findBar?.holdsKeys()) return true;
  for (const id of ["settings-overlay", "shortcut-overlay", "session-overlay"]) {
    const el = document.getElementById(id);
    if (el && !(el as HTMLElement).hidden) return true;
  }
  if (projectDialog?.isOpen()) return true;
  const sessionSettings = document.querySelector<HTMLElement>(".session-settings-overlay");
  return !!sessionSettings && !sessionSettings.hidden;
}

function applyOwnership(next: Ownership) {
  const changed =
    !own ||
    own.owner !== next.owner ||
    own.state !== next.state ||
    own.override !== next.override;
  own = next;
  const takes = next.owner === "input_bar";
  const guess = next.confidence === "guess";

  // 输入权已经回到终端：覆盖层还开着只会让人往一个禁用的输入条里填命令，直接关掉。
  // 放在读焦点之前，隐藏后浏览器把焦点交回 body，下面的逻辑再把焦点还给终端。
  if (!takes && !histOverlay.hidden) closeHistoryOverlay(false, false);

  dot.className = guess ? "guess" : takes ? "ok" : "";
  bar.className = takes ? "ok" : guess ? "guess" : "pass";
  // 串口的状态点、按钮文案、错误提示都挂在同一条输入条上：统一由 renderBarStatus 画，
  // 免得重设 className 抹掉暂停 / 断开这些不是所有权的一部分的状态。
  renderBarStatus();

  // 可输入的判定口径：OSC 133 A 推进到 prompt_ready 的那一刻。
  // 只记第一次，后续提示符漂移不改写冷启动数字。挂回旧会话时不计量。
  if (coldStart.measuring && !coldStart.inputReadyAt && next.id === coldStart.session && next.state === "prompt_ready") {
    coldStart.inputReadyAt = performance.now();
    const ms = Math.round(coldStart.inputReadyAt - t0);
    log(`可输入 ${ms}ms · 提示符就绪（OSC 133 A）`);
    void invoke("bench_report", {
      text: `input-ready ${ms}ms (module eval -> OSC 133 A)`
    });
  }

  ib.disabled = !takes;
  renderSendAvailability();
  renderTree();
  // 把焦点搬到当前该收键盘的地方。只让开两种情况：正在编辑输入框/下拉，
  // 或者开着模态对话框。其余（body、侧栏/标题栏按钮、刚消失的菜单项）都接管——
  // 新建会话是从按钮点出来的，Git Bash 启动很快，提示符可能早于菜单关闭就到，
  // 旧逻辑见焦点不在两个输入目标上就不动，结果键盘谁都不接收。
  const active = document.activeElement;
  const editable =
    active instanceof HTMLElement &&
    (active.matches("input, textarea, select") || active.isContentEditable);
  const transient =
    active === null ||
    active === document.body ||
    (active instanceof HTMLElement && active.matches("button, [role='menuitem']"));
  const view = focusView();
  if (
    !blocksOwnershipFocus() &&
    (active === ib || (view !== null && active === view.term.textarea) || (!editable && transient))
  ) {
    if (takes) ib.focus();
    else view?.term.focus();
  }
  if (changed) {
    console.log(`[own] ${next.state}/${next.owner}/${next.confidence} override=${next.override}`);
  }
  updateGhost();
}

async function setOverrideFor(id: string, mode: Exclude<OverrideMode, "none">) {
  let current: OverrideMode = id === focusSessionId && own?.id === id ? own.override : "none";
  if (id !== focusSessionId) {
    try {
      current = (await invoke<Ownership>("pty_ownership", { id })).override;
    } catch (err) {
      console.warn(`[ownership] ${String(err)}`);
      return;
    }
  }
  try {
    await invoke("pty_set_override", { id, mode: current === mode ? "none" : mode });
    if (id === focusSessionId) applyOwnership(await invoke<Ownership>("pty_ownership", { id }));
  } catch (err) {
    console.warn(`[ownership] ${String(err)}`);
  }
}

function toggleOverride(mode: Exclude<OverrideMode, "none">) {
  if (focusSessionId) void setOverrideFor(focusSessionId, mode);
}

// ---------- 输入条按钮：暂停 / 断开 / 清屏 / 直通 / 接管 ----------
// 这些动作此前只有快捷键，鼠标点不到。按钮一律不抢焦点：点完焦点还在终端或输入框，
// 可以接着敲键盘（否则点完「接管」还得再点一次输入框才能打字）。

/// 终端通道：暂停接收输出（显示层开关，后端仍然记回放）。
/// 串口通道：`serialStatus.paused` 才是「端口已释放」——那里的暂停是真关句柄。
let paused = false;

/// 当前会话是不是串口。由会话树里的 `transport` 决定，切会话时重设。
let serialKind = false;
/// 当前串口会话的状态（`serial:status` 与 `serial_status` 的载荷）。终端会话恒为 null。
let serialStatus: SerialStatus | null = null;
/// HEX 发送开关按会话记：切走再切回来还是上次的样子。
/// 真正的解析在 core-domain，这里只表达「这次发送按十六进制读」。
let hexMode = false;

/// 输入条右侧的临时提示（HEX 解析失败、端口被别的程序抢走……）。
/// 和「暂停中」共用同一个位置：同一时刻只可能有一件需要说的事。
let notice = "";
let noticeIsError = false;
let noticeTimer: number | undefined;

function showNotice(text: string, isError = true, ttl = 6000) {
  notice = text;
  noticeIsError = isError;
  window.clearTimeout(noticeTimer);
  if (ttl > 0) {
    noticeTimer = window.setTimeout(() => {
      notice = "";
      renderBarStatus();
    }, ttl);
  }
  renderBarStatus();
}

/// 把「所有权 + 通道状态」画到输入条上。所有会改这些状态的地方都只调它，
/// 不各自去改 className，否则后画的会抹掉先画的（暂停、断开、错误都是同一行）。
function renderBarStatus() {
  const takes = own?.owner === "input_bar";

  // 串口列表只做展示：高亮当前焦点串口会话占用的端口（终端会话/无会话都不亮）
  serialPortsPanel?.setActivePort(serialKind ? serialStatus?.config.port ?? null : null);

  bar.classList.toggle("serial", serialKind);
  bar.classList.toggle("failed", serialKind && serialStatus?.status === "failed");
  bar.classList.toggle("paused", serialKind ? !!serialStatus?.paused : paused);

  // 串口的状态点：连上=绿、主动断开=琥珀、读写失败=红。终端的点只表达所有权。
  dot.classList.toggle("err", serialKind && serialStatus?.status === "failed");
  dot.classList.toggle("warn", serialKind && (!serialStatus || serialStatus.paused || serialStatus.status === "released"));
  dot.classList.toggle("ok", serialKind && serialStatus?.status === "open" && takes);
  // 查找条开着并且拿着键盘焦点时，按键既不归输入条也不归通道：状态点要说实话
  const findKeys = findBar?.holdsKeys() ?? false;
  dot.classList.toggle("find", findKeys);
  dot.title = findKeys ? t("find.ownsKeys") : "";

  let labelText: string;
  if (own?.override === "passthrough") {
    labelText = t("input.lockedPassthrough");
  } else if (own?.override === "input_bar") {
    labelText = t("input.lockedInput");
  } else if (serialKind) {
    if (!serialStatus) {
      labelText = t("input.serialConnecting");
    } else if (serialStatus.status === "failed") {
      labelText = t("input.serialFailed", { port: serialStatus.config.port });
    } else if (serialStatus.paused || serialStatus.status === "released") {
      labelText = t("input.serialDisconnected", { port: serialStatus.config.port });
    } else {
      labelText = `${serialStatus.config.port} · ${serialStatus.config.baud}`;
    }
  } else {
    labelText = "";
  }
  ownLabel.textContent = labelText;
  ownLabel.hidden = true;
  // 按钮文案 = 当前按键实际归谁（直通 = 透传给终端，接管 = 输入条在收键）；
  // 高亮（.on）表示这是用户显式锁定的，没亮就是状态机自动判的。
  // 之前显示的是「下一步动作」，和状态点对不上：点了「接管」要再点一次才真正接管。
  const locked = own?.override !== "none";
  const showTakeover = own?.override === "input_bar"
    || (own?.override === "none" && own?.owner === "input_bar");
  ibOverride.textContent = showTakeover ? t("session.takeover") : t("session.passthrough");
  ibOverride.title = own?.override === "passthrough"
    ? t("input.lockedPassthroughHint")
    : own?.override === "input_bar"
      ? t("input.lockedInputHint")
      : t("input.overrideHint");
  ibOverride.classList.toggle("on", locked);

  // 同一格文案的优先级：临时错误 > 串口失败 > 串口断开 > 终端暂停中
  if (notice) {
    ibPaused.hidden = false;
    ibPaused.textContent = notice;
    ibPaused.title = notice;
    ibPaused.classList.toggle("err", noticeIsError);
  } else if (serialKind && serialStatus?.status === "failed") {
    ibPaused.hidden = false;
    ibPaused.textContent = t("input.connectFailed");
    ibPaused.title = serialStatus.error ?? "";
    ibPaused.classList.add("err");
  } else if (serialKind && (serialStatus?.paused || serialStatus?.status === "released")) {
    ibPaused.hidden = false;
    ibPaused.textContent = t("input.portDropped");
    ibPaused.title = t("input.pausedHint");
    ibPaused.classList.remove("err");
  } else if (!serialKind) {
    ibPaused.hidden = !paused;
    ibPaused.textContent = t("input.paused");
    ibPaused.title = "";
    ibPaused.classList.remove("err");
  } else {
    ibPaused.hidden = true;
  }

  if (serialKind) {
    ibLog.disabled = !serialStatus?.log;
    ibLog.title = serialStatus?.log
      ? t("input.logHint")
      : t("input.noLog");
  } else {
    ibLog.disabled = true;
  }
}

/// 切会话/切回来时按后端的真实状态复原按钮：暂停是后端的开关，
/// 前端只记「当前会话」的那一份，不能凭上一个会话的记忆画按钮。
async function syncPaused(id: string) {
  const revision = pauseStateRevision.get(id) ?? 0;
  let next = false;
  try {
    next = await invoke<boolean>("pty_paused", { id });
  } catch (err) {
    console.warn(`[pause] ${String(err)}`);
  }
  if (focusSessionId !== id || (pauseStateRevision.get(id) ?? 0) !== revision) return;
  pausedBySession.set(id, next);
  paused = next;
  renderTree();
  renderBarStatus();
}

/// 串口会话的状态（端口是否握在手里、错误、日志路径）。终端会话不调这里。
async function syncSerial(id: string) {
  try {
    const next = await invoke<SerialStatus>("serial_status", { id });
    serialStatusBySession.set(id, next);
    if (focusSessionId === id) {
      serialStatus = next;
      paused = next.paused;
    }
  } catch (err) {
    console.warn(`[serial] ${String(err)}`);
    serialStatusBySession.delete(id);
    if (focusSessionId === id) serialStatus = null;
  }
  renderTree();
  if (focusSessionId === id) renderBarStatus();
}

/// 暂停 = 冻结画面但不丢数据：后端照常把输出记进回放缓冲，只是不再推事件。
/// 继续时整屏按回放重画一次——只把后续增量画在旧屏幕上会与 Shell 的屏幕错位
/// （它以为光标在某一行，实际早就不是了）。
///
/// 串口会话的同一个按钮是「断开 / 连接」：断开真的关掉端口句柄（别的程序能用），
/// 连接按原配置重开并起新的读线程。回放与历史都不动，所以不必重画屏幕。
async function togglePauseFor(id: string, transport: TreeSession["transport"]) {
  if (transport === "serial") {
    let status = id === focusSessionId ? serialStatus : null;
    if (!status) {
      try {
        status = await invoke<SerialStatus>("serial_status", { id });
      } catch (err) {
        showNotice(t("globalSettings.updateFailed", { error: String(err) }), true);
        return;
      }
    }
    const down = status.paused || status.status !== "open";
    try {
      if (down) await invoke("serial_connect", { id });
      else await invoke("serial_disconnect", { id });
    } catch (err) {
      const reason = spawnErrorText(err);
      if (id === focusSessionId) showNotice(t("input.connectFailed") + ": " + reason, true, 8000);
      else console.warn(`[serial] ${reason}`);
    }
    if (id === focusSessionId) await syncSerial(id);
    else {
      try {
        const updated = await invoke<SerialStatus>("serial_status", { id });
        serialStatusBySession.set(id, updated);
      } catch (err) {
        console.warn(`[serial] ${String(err)}`);
      }
    }
    renderTree();
    await refreshTree();
    return;
  }
  const operationKey = id;
  if (pauseOperations.has(operationKey)) return;
  pauseOperations.add(operationKey);
  const revision = (pauseStateRevision.get(id) ?? 0) + 1;
  pauseStateRevision.set(id, revision);
  try {
    const current = await invoke<boolean>("pty_paused", { id });
    if ((pauseStateRevision.get(id) ?? 0) !== revision) return;
    const next = !current;
    await invoke<boolean>("pty_set_paused", { id, paused: next });
    if ((pauseStateRevision.get(id) ?? 0) !== revision) return;
    pausedBySession.set(id, next);
    renderTree();
    if (id === focusSessionId) {
      paused = next;
      renderBarStatus();
    }
    // 暂停/继续是显示层动作，按 id 生效：只要这一格有视图就补画，
    // 不管它是不是焦点。恢复后不重放，暂停期间后端没推的那段会永久缺在屏幕上。
    if (next) flushOut(id);
    else if (pool.view(id)) await resyncScreen(id);
  } catch (err) {
    console.warn(`[pause] ${String(err)}`);
  } finally {
    pauseOperations.delete(operationKey);
  }
}

async function togglePause() {
  if (!focusSessionId) return;
  await togglePauseFor(focusSessionId, serialKind ? "serial" : "terminal");
}

/// 清窗口：屏幕、回放缓冲、磁盘上的卷轴快照一起清，进程与命令历史不动。
/// 不往 Shell 发 Ctrl+L：跑着 logcat 之类时那不是「清屏」而是往 stdin 塞控制字符。
/// 代价是 Shell 仍以为屏幕上有内容，全屏程序（vim / less）要它们自己的 Ctrl+L 重画。
async function clearScreenFor(id: string) {
  if (!id) return;
  let lastCleared = 0;
  try {
    lastCleared = await invoke<number>("pty_clear", { id });
  } catch (err) {
    console.warn(`[clear] ${String(err)}`);
    return;
  }
  // 清屏按 id 生效：可见但非焦点的格子也必须一起清，否则后端清了、屏幕还留着旧内容
  const view = pool.view(id);
  const out = outputOf(id);
  dropOutQueue(id);
  out.floor = Math.max(out.floor, lastCleared);
  out.lastSeq = Math.max(out.lastSeq, lastCleared);
  noteAnswered(id, lastCleared);
  // 清屏会清掉缓冲区：查找条连查询一起关掉，别让切回来还挂着一屏高亮
  findBar?.closeFor(id);
  if (!view) return;
  const transport = tree.find((session) => session.id === id)?.transport ?? "terminal";
  if (clearDisplayMode(transport) === "reset") {
    view.term.reset();
    resyncBackgrounds(view.term);
  } else {
    view.term.clear();
  }
}

async function clearScreen() {
  if (focusSessionId) await clearScreenFor(focusSessionId);
}

for (const btn of [ibHex, ibLog]) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

/// HEX 模式：只改「这次发送怎么读」，不改变输入内容。解析与拒绝原因都在核心。
ibHex.addEventListener("click", () => {
  if (!serialKind || !focusSessionId) return;
  hexMode = !hexMode;
  uiOf(focusSessionId).hex = hexMode;
  ibHex.classList.toggle("on", hexMode);
  ib.placeholder = serialKind
    ? hexMode ? t("input.placeholderHex") : t("input.placeholderSerial")
    : t("input.placeholder");
  if (hexMode) {
    ib.value = normalizeHexInput(ib.value);
    ib.setSelectionRange(ib.value.length, ib.value.length);
  }
  ib.focus();
  updateGhost();
});

/// 打开本会话的串口日志。没有日志文件（数据目录不可写）就直说，不静默失败。
ibLog.addEventListener("click", () => {
  const path = serialStatus?.log;
  if (!path) {
    showNotice(t("input.noLog"), true);
    return;
  }
  void invoke("fs_open", { path }).catch((err) => showNotice(String(err), true));
});

// 快捷键放在捕获阶段，避免 xterm 先吃掉按键
window.addEventListener(
  "keydown",
  (e) => {
    // 新建会话 / 新建项目弹窗开着时，按键属于表单：Esc 关闭、Enter 提交都由它自己处理，
    // 不能让 Ctrl+Shift+P / Ctrl+R 之类在对话框里生效。
    if (sessionDialog?.isOpen() || projectDialog?.isOpen()) return;
    if (DEBUG) {
      const t = e.target as HTMLElement | null;
      trace(
        `key #${bootNo} ${e.key}/${e.code} ctrl=${e.ctrlKey ? 1 : 0} shift=${e.shiftKey ? 1 : 0} ` +
          `own=${own?.owner ?? "-"} overlay=${histOverlay.hidden ? 0 : 1} ` +
          `target=${t?.tagName ?? "?"}#${t?.id || "-"} focus=${document.activeElement?.id || "-"} ` +
          `defaultPrevented=${e.defaultPrevented ? 1 : 0}`
      );
    }
    // Ctrl+R 是历史检索的开关键：开着就关掉。终端直通时留给 Shell 自己的 Ctrl+R。
    // 浏览器加速键已在 Rust 侧关掉（见 main.rs 的 AreBrowserAcceleratorKeysEnabled），
    // 这里拦下来的只是本应用的开关，不会再触发页面重载。
    if (e.ctrlKey && !e.shiftKey && matchesKey(e, "KeyR", "r")) {
      // 串口没有命令历史与检索能力（`caps.history = false`），Ctrl+R 什么都不做
      const activeSession = tree.some((session) => session.id === focusSessionId) && live.has(focusSessionId);
      if (!serialKind && (!activeSession || own?.owner === "input_bar" || !histOverlay.hidden)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // 长按只开/关一次，别让覆盖层闪成跑马灯
        if (histOverlay.hidden) openHistoryOverlay();
        else closeHistoryOverlay(true);
        return;
      }
    }
    // Ctrl+Alt+方向键：项目内按几何方向搬焦点。部分 Intel 显卡驱动把这一组当成
    // 旋转屏幕快捷键，所以同时接受 Ctrl+Alt+H/J/K/L 作为退路；两条都走同一套
    // 几何最近邻。必须在捕获阶段拦下，否则焦点搬走的同时方向键会打进 vim。
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && !e.getModifierState("AltGraph")) {
      const direction = directionOfKey(e);
      if (direction && currentProject()?.layout) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void moveFocusDirection(direction);
        return;
      }
    }
    if (!e.ctrlKey || !e.shiftKey) return;
    if (matchesKey(e, "KeyP", "p")) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleOverride("passthrough");
    } else if (matchesKey(e, "KeyL", "l")) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleOverride("input_bar");
    } else if (matchesKey(e, "KeyK", "k")) {
      // 清屏只动显示层：工具提示里一直写着 Ctrl+Shift+K，这里把它接上
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void clearScreen();
    } else if (matchesKey(e, "KeyF", "f")) {
      // 查找只作用于屏幕内容，所以入口用 Ctrl+Shift+F 独占：Ctrl+F 是 Shell 的
      // forward-char / ForwardWord，抢走它会打断行编辑。直通与备用屏下也截获——
      // 用户显式要查，代价是那一刻按键不进程序，状态点会如实显示。
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (!histOverlay.hidden) closeHistoryOverlay(true, false);
      findBar?.toggle();
    } else if (matchesKey(e, "Space", " ")) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void togglePause();
    }
  },
  true
);

// 输入条是命令的唯一入口：终端发「文本 + 回车」，串口按会话的发送方式与行结束符组包
// （HEX 模式下整行按十六进制解析，核心负责拒绝非法输入）。
// 发送失败时把这一行还给输入条：端口断了、HEX 位数不对都不该让用户重敲。
function sendLine(id: string, line: string) {
  if (!id) return;
  if (serialKind && hexMode) {
    const clean = normalizeHexInput(line).replaceAll(" ", "");
    if (clean.length % 2 !== 0) {
      ib.value = line;
      ib.setSelectionRange(ib.value.length, ib.value.length);
      showNotice(t("input.hexOdd"), true);
      return;
    }
    line = normalizeHexInput(clean);
  }
  const hex = serialKind && hexMode;
  void invoke("pty_send_line", { id, line, hex }).then(
    () => {
      if (noticeIsError && focusSessionId === id) {
        notice = "";
        noticeIsError = false;
        window.clearTimeout(noticeTimer);
        renderBarStatus();
      }
    },
    (err) => {
      if (focusSessionId !== id) return;
      if (!ib.value) ib.value = line;
      renderSendAvailability();
      ib.setSelectionRange(ib.value.length, ib.value.length);
      showNotice(String(err), true, 8000);
      if (serialKind) void syncSerial(id);
    }
  );
}

async function executeShortcut(command: string): Promise<void> {
  const id = focusSessionId;
  if (!id) throw new Error(t("input.noSession"));
  const transport = serialKind ? "serial" : "terminal";
  const isPaused = serialKind
    ? !!serialStatus?.paused || serialStatus?.status !== "open"
    : paused;
  if (isPaused) {
    await togglePauseFor(id, transport);
    const stillPaused = serialKind
      ? !!serialStatus?.paused || serialStatus?.status !== "open"
      : paused;
    if (stillPaused || focusSessionId !== id) throw new Error(t("input.paused"));
  }
  await invoke("pty_write", { id, data: `${command}\r` });
}

function fillShortcut(command: string) {
  const id = focusSessionId;
  if (!id) return;
  const applyFill = () => fillInputBar(command);
  if (own?.id === id && own.override === "passthrough") {
    void invoke("pty_set_override", { id, mode: "input_bar" })
      .then(() => invoke<Ownership>("pty_ownership", { id }))
      .then((ownership) => { if (focusSessionId === id) { applyOwnership(ownership); applyFill(); } })
      .catch((err) => showNotice(`切回输入模式失败：${String(err)}`, true));
    return;
  }
  applyFill();
}

async function sendInput() {
  const line = ib.value;
  if (!line.trim()) return; // 空白回车不发：后端本来也不记，只是白多打一次提示符

  const id = focusSessionId;
  if (!id) return;
  const transport = serialKind ? "serial" : "terminal";
  const isPaused = serialKind
    ? !!serialStatus?.paused || serialStatus?.status !== "open"
    : paused;
  if (isPaused) {
    await togglePauseFor(id, transport);
    const stillPaused = serialKind
      ? !!serialStatus?.paused || serialStatus?.status !== "open"
      : paused;
    if (stillPaused || focusSessionId !== id) return;
  }

  ib.value = "";
  renderSendAvailability();
  histIdx = -1;
  histDraft = "";
  sendLine(id, line);
  updateGhost();
}

function renderSendAvailability() {
  ibSend.disabled = ib.disabled || !ib.value.trim();
  const lockedAway = own?.override === "passthrough";
  bar.classList.toggle("direct", lockedAway);
  resizer.classList.toggle("direct", lockedAway);
}

ibSend.addEventListener("click", () => sendInput());
ibSend.addEventListener("mousedown", (e) => e.preventDefault());
ibHistory.addEventListener("click", () => {
  if (histOverlay.hidden) openHistoryOverlay();
  else closeHistoryOverlay(true);
});
ibHistory.addEventListener("mousedown", (e) => e.preventDefault());
ibOverride.addEventListener("click", () => {
  toggleOverride(own?.override === "passthrough" ? "input_bar" : "passthrough");
});
ibOverride.addEventListener("mousedown", (e) => e.preventDefault());

ib.addEventListener("keydown", (e) => {
  // 输入法组合期间（拼音选字）不响应 Enter / 方向键，否则会把半截拼音当成命令发出去
  if (e.isComposing || composing) return;
  // → 接受整条 Ghost Text；只在光标位于行尾、没有选区、也没按修饰键时生效
  if (
    e.key === "ArrowRight" &&
    currentGhost &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    ib.selectionStart === ib.value.length &&
    ib.selectionEnd === ib.value.length
  ) {
    e.preventDefault();
    ib.value += currentGhost;
    currentGhost = "";
    ghostEl.textContent = "";
    return;
  }
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    sendInput();
  } else if (e.key === "Enter" && !e.shiftKey) {
    if (serialKind || !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      sendInput();
    }
  } else if (e.key === "ArrowUp") {
    if (!hist.length) return;
    e.preventDefault();
    if (histIdx === -1) {
      histDraft = ib.value;
      histIdx = hist.length - 1;
    } else if (histIdx > 0) {
      histIdx--;
    }
    ib.value = hist[histIdx] ?? "";
    renderSendAvailability();
    ib.setSelectionRange(ib.value.length, ib.value.length);
    updateGhost();
  } else if (e.key === "ArrowDown") {
    if (histIdx === -1) return;
    e.preventDefault();
    if (histIdx < hist.length - 1) {
      histIdx++;
      ib.value = hist[histIdx] ?? "";
    } else {
      histIdx = -1;
      ib.value = histDraft;
      histDraft = "";
    }
    renderSendAvailability();
    ib.setSelectionRange(ib.value.length, ib.value.length);
    updateGhost();
  } else if (e.key === "Escape") {
    e.preventDefault();
    ib.value = "";
    renderSendAvailability();
    histIdx = -1;
    histDraft = "";
    updateGhost();
  } else if (e.key === "Tab") {
    // 还没有补全，先把 Tab 占住，别让它把焦点送出输入条
    e.preventDefault();
  }
});

// Ghost Text 跟着文本、光标与焦点走；建议本身不可选中
// 手动改过文本就不再算「正在翻历史」：↑↓ 游标归位，否则下一次 ↑ 会从旧位置继续跳条。
ib.addEventListener("input", () => {
  renderSendAvailability();
  if (serialKind && hexMode) {
    const start = ib.selectionStart ?? ib.value.length;
    const normalized = normalizeHexInput(ib.value);
    if (normalized !== ib.value) {
      const before = normalizeHexInput(ib.value.slice(0, start));
      ib.value = normalized;
      const caret = before.length;
      ib.setSelectionRange(caret, caret);
    }
  }
  histIdx = -1;
  histDraft = "";
  updateGhost();
});
ib.addEventListener("keyup", updateGhost);
ib.addEventListener("click", updateGhost);
ib.addEventListener("focus", updateGhost);
ib.addEventListener("select", updateGhost);
ib.addEventListener("compositionstart", () => {
  composing = true;
  currentGhost = "";
  ghostEl.textContent = "";
});
ib.addEventListener("compositionend", () => {
  composing = false;
  updateGhost();
});
ib.addEventListener("blur", () => {
  composing = false;
  currentGhost = "";
  ghostEl.textContent = "";
});

// 输出按帧聚合：来一块就画一块会在 vim 全屏重绘时掉帧（见 docs/bench-m0.md）
const OUT_FLUSH_MS = 16;
const OUT_MAX_PENDING = 512;

/// 丢弃某个视图还没画的块（切走、清屏时用）：它们属于旧屏幕，画上去只会污染画面。
function dropOutQueue(id: string) {
  const out = outputOf(id);
  if (out.timer !== undefined) {
    window.clearTimeout(out.timer);
    out.timer = undefined;
  }
  out.queue.length = 0;
}

function flushOut(id: string) {
  const out = outputOf(id);
  if (out.timer !== undefined) {
    window.clearTimeout(out.timer);
    out.timer = undefined;
  }
  if (!out.queue.length) return;
  const chunks = out.queue;
  out.queue = [];
  // 清屏那一刻可能还有旧块在路上：按序号把它们滤掉，只画真正在清屏之后产生的块
  const { parts, lastSeq: seq } = keepAfter(chunks, out.floor);
  if (!parts.length) return;
  const view = pool.view(id);
  // 视图不存在或不可见：不画，数据仍在后端回放缓冲里，切回时整屏重建
  if (!view || !view.visible) return;
  view.term.write(parts.join(""));
  // 画过即答过：终端查询的应答就在这次写入里发生
  if (seq) noteAnswered(id, seq);
}

function queueOut(id: string, data: string, seq: number) {
  const out = outputOf(id);
  if (seq <= out.floor) return; // 清屏前的块，直接丢
  out.queue.push({ data, seq });
  // 异常爆发时不等帧：先画出来，别把内存堆掉
  if (out.queue.length >= OUT_MAX_PENDING) {
    flushOut(id);
    return;
  }
  if (out.timer === undefined) {
    out.timer = window.setTimeout(() => flushOut(id), OUT_FLUSH_MS);
  }
}

const listenOut = listen<{ id: string; seq: number; data: string }>("pty:out", (event) => {
  const payload = event.payload;
  markSessionActivity(payload.id);
  // 路由按 id 走视图，不再看焦点：四个格子同时刷输出时各画各的
  const view = pool.view(payload.id);
  if (!view || !view.visible) return;
  const out = outputOf(payload.id);
  // 先在本地排队，等回放落地再按 seq 去重补上
  if (out.attaching) {
    out.pending.push({ seq: payload.seq, data: payload.data });
    return;
  }
  if (payload.seq <= out.lastSeq) return;
  out.lastSeq = payload.seq;
  noteFirstOutput();
  queueOut(payload.id, payload.data, payload.seq);
});

/// 冷启动计量只认第一次输出；挂回旧会话时 coldStart.measuring 为假，只补画不计量。
function noteFirstOutput() {
  if (coldStart.firstOutputAt || !coldStart.measuring || focusSessionId !== coldStart.session) return;
  coldStart.firstOutputAt = performance.now();
  log(`session ${focusSessionId.slice(0, 8)} · 首个字节 ${Math.round(coldStart.firstOutputAt - t0)}ms`);
  if (location.hash === "#bench" && !benchScheduled) {
    benchScheduled = true;
    window.setTimeout(() => void runBench(), 1500);
  }
}

const listenExit = listen<{ id: string }>("pty:exit", (event) => {
  const id = event.payload.id;
  const view = pool.view(id);
  if (!view) {
    void refreshTree();
    return;
  }
  flushOut(id);
  // 附着途中（整屏还在 reset/回放）不要把退出提示写进正在搭建的屏幕：
  // 等回放完成后由 refreshTree 标冷呈现，这里只用 HUD 提一句。
  if (outputOf(id).attaching) {
    log(`session ${id.slice(0, 8)} · 进程已退出`);
  } else {
    view.term.writeln("\r\n\x1b[38;5;245m[进程已退出]\x1b[0m");
  }
  void refreshTree().then(() => {
    // 项目格：进程自己退出等同于「关格」——节点留着、格子原位变冷，
    // 只换这一格，不重挂整棵树（另外几格的画面与尺寸都不该动）。
    const project = currentProject();
    if (project && projectLeaves(project).includes(id)) {
      destroyView(id, { runtimeAlive: false });
      markPaneCold(id);
      // 焦点格自己退出：输入条没有可发送的对象，必须立刻进入空保护禁用态
      if (focusSessionId === id) {
        own = null;
        ib.disabled = true;
        renderBarStatus();
        renderSendAvailability();
      }
      renderTree();
    }
  });
});

const listenOwn = listen<Ownership>("pty:ownership", (event) => {
  if (event.payload.id !== focusSessionId) return;
  applyOwnership(event.payload);
});

// 串口状态：连上 / 主动断开 / 读写失败。后端只在变化时发，前端只负责画。
const listenSerial = listen<SerialStatus>("serial:status", (event) => {
  serialStatusBySession.set(event.payload.id, event.payload);
  if (event.payload.id === focusSessionId) {
    serialStatus = event.payload;
    paused = event.payload.paused;
    renderBarStatus();
  }
  renderTree();
});

// 会话 CWD 变了（Shell 每次提示符上报 OSC 7）。只有真变化后端才发，不是每个回车一帧。
const listenCwd = listen<{ id: string; cwd: string }>("session:cwd", (event) => {
  const item = tree.find((session) => session.id === event.payload.id);
  if (item) item.cwd = event.payload.cwd;
  filePanel?.onCwd(event.payload.id);
});

// 历史缓存增量：只有当前会话的追加会进缓存；id 严格 +1，缺口就整份重建（L2-02）
const listenHistory = listen<{ session_id: string; item: HistoryItem }>("history:append", (event) => {
  const outcome = applyAppend(cache, focusSessionId, event.payload);
  if (outcome.kind === "rebuild") {
    void rebuildHistory(focusSessionId); // 跳号 / 缓存还没为该会话建好：整份重建，不逐条修补
  } else if (outcome.kind === "append") {
    cache = outcome.cache;
    onHistoryChanged();
  }
});

const listenHistoryDegraded = listen("history:degraded", () => {
  console.warn("[history] 历史未保存：本次运行只在内存里");
});

// 页面重载（F5 / HMR）故意不结束会话：靠回放缓冲挂回原样。
// 退出应用时由后端在窗口关闭事件里结束全部进程（不变量 I3）。

// ---------- 基准（M0 验收用） ----------
function pct(sorted: number[], p: number) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

const bench = {
  /** IPC 往返：小消息延迟 */
  async ping(n = 300) {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await invoke("bench_ping");
      samples.push(performance.now() - s);
    }
    samples.sort((a, b) => a - b);
    return {
      p50: +pct(samples, 50).toFixed(3),
      p95: +pct(samples, 95).toFixed(3),
      p99: +pct(samples, 99).toFixed(3),
      max: +samples[samples.length - 1].toFixed(3)
    };
  },

  /** 渲染吞吐：在离屏终端里写入 N MB 文本，避免污染当前会话视图 */
  async flood(mb = 1) {
    if (!benchTerm) {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:800px;height:600px;";
      document.body.appendChild(host);
      benchTerm = new Terminal({ cols: 100, rows: 40, scrollback: 1000 });
      benchTerm.open(host);
    }
    const line = "0123456789abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";
    const times = Math.ceil((mb * 1024 * 1024) / line.length);
    const payload = line.repeat(times);
    const s = performance.now();
    await new Promise<void>((resolve) => benchTerm!.write(payload, resolve));
    const ms = performance.now() - s;
    return { mb, ms: Math.round(ms), mbs: +(mb / (ms / 1000)).toFixed(2) };
  },

  /** 冷启动：从模块求值到首个 PTY 输出（下限）与到提示符就绪（真正的可输入时刻） */
  coldStart() {
    return {
      firstByteMs: coldStart.firstOutputAt ? Math.round(coldStart.firstOutputAt - t0) : null,
      inputReadyMs: coldStart.inputReadyAt ? Math.round(coldStart.inputReadyAt - t0) : null
    };
  }
};

declare global {
  interface Window {
    __pinshellBench: typeof bench;
  }
}
window.__pinshellBench = bench;

/** 启动后自动跑一遍基准，结果写到右下角 HUD 和控制台 */
async function runBench() {
  try {
    const ping = await bench.ping(300);
    const flood = await bench.flood(1);
    const ready = coldStart.inputReadyAt
      ? `可输入 ${Math.round(coldStart.inputReadyAt - t0)}ms`
      : "可输入 未就绪";
    const text =
      `前端 ${Math.round(coldStart.spawnStart - t0)}ms + spawn ${Math.round(coldStart.spawnReturn - coldStart.spawnStart)}ms + ` +
      `${ready}（首字节 ${Math.round(coldStart.firstOutputAt - coldStart.spawnReturn)}ms） · IPC p50 ${ping.p50}ms/p99 ${ping.p99}ms · ` +
      `1MB ${flood.ms}ms (${flood.mbs} MB/s) · webgl ${focusView()?.webgl ? "on" : "off"}`;
    log(text);
    void invoke("bench_report", { text });
  } catch (err) {
    log("基准失败: " + String(err));
  }
}

// 项目栏先装配：功能栏的宽度上限要量它当前多宽，顺序反了第一帧会算错
const sidebarHandle = setupSidebar({ layoutChanged: () => syncSize() });
setupInputbarResize({
  // 拖高/双击重置/窗口缩放后回调：输入条高度变了，Ghost Text 的定位度量一并失效
  layoutChanged: () => {
    invalidateGhostMetrics();
    syncSize();
  }
});

filePanel = setupFilePanel({
  sessionId: () => focusSessionId,
  cwdOf: (id) => tree.find((session) => session.id === id)?.cwd ?? null,
  fillInput: (text) => fillInputBar(text),
  layoutChanged: () => syncSize()
});

// 自绘标题栏：窗口按钮 + 两侧栏折叠。项目栏的折叠能力在装配时一起建好。
const filePanelHandle = filePanel;
setupTitlebar({ left: sidebarHandle, right: filePanelHandle });

sessionSettingsUi = setupSessionSettingsUi({
  saved: async (id) => {
    await refreshTree();
    if (id === focusSessionId) {
      filePanel?.onCwd(id);
      applyFontSize(tree.find((session) => session.id === id)?.settings.font_size ?? DEFAULT_FONT_SIZE);
    }
  },
  fontSizePreview: (id, size) => {
    if (id === focusSessionId) applyFontSize(size);
  }
});

shortcutsUi = setupShortcutsUi({
  sessionId: () => focusSessionId,
  fill: fillShortcut,
  execute: executeShortcut,
  layoutChanged: () => syncSize()
});

// 查找条：每分格一条，挂在各自的终端视图里，只搜前端缓冲区（docs/find.md、ADR 0009）。
// 放在快捷指令之后装配：它只依赖 pool 与焦点 id，DOM 是第一次按 Ctrl+Shift+F 时才建的。
findBar = setupFindBar({
  view: (id) => pool.view(id),
  activeId: () => focusSessionId,
  restoreFocus: (id) => {
    if (id !== focusSessionId) return;
    // 关掉查找条之后，键该回哪就回哪：输入条拥有按键就回输入条，否则回终端
    if (own?.owner === "input_bar" && !ib.disabled) {
      ib.focus();
      ib.setSelectionRange(ib.value.length, ib.value.length);
    } else {
      pool.focus(id);
    }
  },
  changed: () => renderBarStatus()
});

// 新建项目 / 项目设置：创建成功后选中并展开，保存后重挂当前项目
projectDialog = setupProjectDialog({
  statsOf: (id) => {
    const project = projects.find((item) => item.id === id);
    return project ? projectStats(project) : { terminal: 0, serial: 0 };
  },
  onCreated: async (id) => {
    activeProjectId = id;
    if (expanded === null) expanded = new Set(projects.map((item) => item.id));
    expanded.add(id);
    saveActiveProject();
    saveExpanded();
    await refreshTree();
    await selectProject(id);
  },
  onSaved: async (id) => {
    await refreshTree();
    renderTree();
    if (activeProjectId === id) {
      const project = currentProject();
      if (project) await mountProject(project);
    }
  }
});

// 新建会话：终端与串口共用一张表单，创建成功后由 `createSessionFromDialog` 搬主区与焦点
sessionDialog = setupSessionDialog({
  create: (request) => createSessionFromDialog(request),
  shellProfiles: () => loadShellProfiles()
});

// 串口列表：只读展示，唯一要喂给它的是「当前焦点串口会话占着哪个口」。
serialPortsPanel = setupSerialPortsPanel();

void Promise.all([
  listenOut,
  listenExit,
  listenOwn,
  listenSerial,
  listenCwd,
  listenHistory,
  listenHistoryDegraded
]).then(boot);

// 首帧兜底样式在 index.html 里：静态 DOM、样式表与各模块都已装配完，
// 现在放行界面，避免启动瞬间闪出未样式化的原生控件。
document.documentElement.classList.add("app-ready");
