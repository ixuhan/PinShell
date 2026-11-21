import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
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
import { setupShortcutsUi } from "./shortcutsUi";
import { DRAGGING_CLASS } from "./resize";
import { setupInputbarResize } from "./inputbarResize";
import { setupSidebar } from "./sidebarUi";
import { invertIds, pruneIds, selectAllIds, toggleId } from "./selection";
import { setupSerialDialog, type SerialConfig } from "./serialUi";
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
import { setupSerialPortsPanel } from "./serialPortsPanelUi";
import { setupSessionSettingsUi, type SessionSettings } from "./sessionSettingsUi";
import { setupTitlebar } from "./titlebar";
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
const sessNew = document.getElementById("sess-new") as HTMLButtonElement;
const sessSelect = document.getElementById("sess-select") as HTMLButtonElement;
const sessBulk = document.getElementById("sess-bulk") as HTMLDivElement;
const sessSelectAll = document.getElementById("sess-select-all") as HTMLButtonElement;
const sessSelectInvert = document.getElementById("sess-select-invert") as HTMLButtonElement;
const sessDeleteSelected = document.getElementById("sess-delete-selected") as HTMLButtonElement;
const sessSelectDone = document.getElementById("sess-select-done") as HTMLButtonElement;
const sessPanel = document.getElementById("sess-panel") as HTMLElement;
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

const term = new Terminal({
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: 1.4,
  cursorBlink: TERMINAL_CURSOR_BLINK,
  scrollback: SCROLLBACK_LINES,
  theme: xtermTheme(readTheme()),
  allowProposedApi: true
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term-host") as HTMLElement);
fit.fit();

let webgl = false;
let webglAddon: WebglAddon | null = null;
function applyWebgl(enabled: boolean) {
  if (enabled && !webglAddon) {
    try {
      webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
        webgl = false;
      });
      webgl = true;
    } catch {
      webglAddon?.dispose();
      webglAddon = null;
      webgl = false;
    }
  } else if (!enabled && webglAddon) {
    webglAddon.dispose();
    webglAddon = null;
    webgl = false;
  }
}
applyWebgl(TERMINAL_WEBGL);

/// 当前会话的字号。切会话时按该会话的设置换一次；会话设置里改完立即生效。
function applyFontSize(size: number) {
  const next = clampFontSize(size);
  if (term.options.fontSize === next) return;
  term.options.fontSize = next;
  fit.fit();
  syncSize();
}

/// 主题变了：CSS 变量由 `applyTheme` 换，终端这边换 canvas 配色。
/// 只改 `theme` 不会重绘已有内容，所以补一次整屏 refresh。
function applyTermTheme() {
  term.options.theme = xtermTheme(readTheme());
  term.refresh(0, term.rows - 1);
}

/// 语言切换后重画本文件生成的动态文案。
/// 静态标注（`data-i18n`）由这里统一刷；各模块自己的动态文案通过 `onLocaleChange` 重画，
/// 这里再补上会话树与输入条状态——它们是本文件直接画的。
function refreshChromeText() {
  applyStaticI18n(document);
  renderTree();
  renderBarStatus();
}

const globalSettings = setupGlobalSettings({
  themeChanged: () => applyTermTheme()
});

document.getElementById("settings-open")!.addEventListener("click", () => globalSettings.open());

onLocaleChange(() => refreshChromeText());

let sessionId = "";
let requestedSessionId = "";
let sessionSwitchToken = 0;
let bytes = 0;
/// 文件面板的句柄：监听器可能先于 setup 收到事件，所以允许为空
let filePanel: ReturnType<typeof setupFilePanel> | null = null;
/// 左栏句柄：标题栏的折叠按钮要用它切换整栏收起
let setupSidebarHandle: ReturnType<typeof setupSidebar> | null = null;
let sessionSettingsUi: ReturnType<typeof setupSessionSettingsUi> | null = null;
let shortcutsUi: ReturnType<typeof setupShortcutsUi> | null = null;
/// 新建串口会话的对话框：按钮在装配前就可能被点到（理论上不会），所以允许为空
let serialDialog: ReturnType<typeof setupSerialDialog> | null = null;
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
let attachToken = 0;
let attaching = false;
let pending: { seq: number; data: string }[] = [];
let lastSeq = 0;
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

function fitTerm() {
  fit.fit();
}

/// xterm 6.0 + `@xterm/addon-webgl` 0.19 的一处缝隙：`term.reset()` 会清字形模型和顶点缓冲，
/// 却不清 WebGL 渲染器里缓存的底色矩形；而 `updateBackgrounds()` 只在「模型里有单元格变了」
/// 时才重算。于是切到一个空屏（回放为空、或清过屏的会话还没吐提示符）时，上一会话的选中底色
/// 会原样留在画布上：屏幕空了，那几条蓝块还在，直到新会话吐出第一个字符把模型改回来。
/// 这里按当前模型重算一次底色矩形就算修好：空模型只剩一条整屏底色，多余的老矩形随之丢掉。
/// DOM 渲染器没有这层缓存（取不到 `_rectangleRenderer`），那时就什么都不做。
function resyncBackgrounds() {
  const renderer = (term as any)._core?._renderService?._renderer?.value;
  const rectangles = renderer?._rectangleRenderer?.value;
  const model = renderer?._model;
  if (!rectangles || !model || typeof rectangles.updateBackgrounds !== "function") return;
  rectangles.updateBackgrounds(model);
}

/// 只把屏幕按回放重画一遍：不动输入草稿、不动历史缓存、不动覆盖层。
/// 「暂停 → 继续」与切会话都用它；区别只在调用方是否先收拾上一个会话的状态。
/// 返回 false 表示没画成（拉快照失败，或期间已经切到别的会话）。
///
/// **快照为空时不动屏幕**：清屏后回放本来就是空的，`reset` 会把 `clear` 特意留在
/// 首行的提示符一起抹掉，留一块全黑的屏幕。切会话的调用方（`attach`）自己负责先把
/// 上一个会话的画面清掉。
async function resyncScreen(id: string): Promise<boolean> {
  const token = ++attachToken;
  attaching = true;
  pending = [];
  dropOutQueue();
  // 快照是新的权威屏幕，但「答到哪儿」仍然算数：小于等于它的块早画过（或被清屏丢掉了），
  // 不能让它们再从在途事件里画一遍。清屏后重画（暂停继续、切走再回来）也靠这条线兜住。
  outFloor = answered.get(id) ?? 0;

  let snap: ReplayPayload;
  try {
    // 画到哪儿就答到哪儿：后端只删「已经答过」的那部分查询
    snap = await invoke<ReplayPayload>("pty_replay", {
      id,
      answeredSeq: answered.get(id) ?? 0
    });
    trace(
      `attach ${id.slice(0, 4)} answered=${answered.get(id) ?? 0} snapSeq=${snap.seq} len=${snap.data.length} queries=${countQueries(snap.data)}`
    );
  } catch (err) {
    attaching = false;
    log(`挂回失败: ${String(err)}`);
    return false;
  }
  if (token !== attachToken || sessionId !== id) {
    attaching = false; // 附着途中又切走了
    return false;
  }

  // 先把终端尺寸对准当前布局，再整屏回放。反过来的话（先写快照、再 fit）会触发一次重排，
  // 底部提示符和滚动位置都会被推走：切回来看到的是被顶上去的一屏，实际输入却在缓冲区末尾。
  fitTerm();
  lastSeq = snap.seq;
  if (snap.data) {
    // 快照会整屏重画：先复位，免得新内容叠在旧画面上（半屏重影）
    term.reset();
    // 复位后视口可能还停在上一会话的滚动位置：先贴回底部并清掉「用户正在翻历史」的标记，
    // 否则整段回放会从顶部开始铺，屏幕上看到的是历史的上半屏，而实际输入位置在缓冲区末尾。
    term.scrollToBottom();
    term.write(snap.data, () => {
      // 回放解析完再贴一次：解析期间或随后的 fit/reflow 都可能把视口带离底部。
      if (token !== attachToken || sessionId !== id) return;
      term.scrollToBottom();
      // WebGL 只重画「变脏」的行。整屏回放 + 重排之后强制刷一遍可见区，
      // 免得画布还留着上一帧的行，看起来像整块内容被顶了上去（模型其实没错）。
      term.refresh(0, term.rows - 1);
      // 底色矩形的缓存也要等解析完再按新模型重算：早一步算的是空屏/半屏。
      resyncBackgrounds();
      // 滚动条高度的变化（reset 后变矮、回放后又变高）是异步派发的，可能晚于这次解析；
      // 再等一拍贴一次，避免它把视口又带回上面。
      window.setTimeout(() => {
        if (token === attachToken && sessionId === id) term.scrollToBottom();
      }, 80);
    });
    // 这一份画过就等于答过：之后再附着，这部分查询交给后端删掉
    noteAnswered(id, snap.seq);
  } else {
    // 空快照：attach 已经 reset 过，这里把视口贴回尾部（否则新输出会画在看不见的位置）
    term.scrollToBottom();
  }
  if (snap.dropped_bytes > 0) {
    console.warn(`[replay] 超出上限丢掉了 ${snap.dropped_bytes} 字节`);
  }

  attaching = false;
  const queued = pending;
  pending = [];
  for (const chunk of queued) {
    if (chunk.seq > lastSeq) {
      lastSeq = chunk.seq;
      noteFirstOutput();
      queueOut(chunk.data, chunk.seq);
    }
  }

  fitTerm();
  // 尺寸变化可能触发重排，最后再贴一次底，保证切回来/继续后停在最新一行
  term.scrollToBottom();
  // 空快照不会让模型发生变化，底色缓存得手动重算一次，否则旧矩形会一直画着
  resyncBackgrounds();
  // 尺寸变了就让 PTY 跟着变：每发一次 shell 就会收到一次 SIGWINCH、重画一次提示符，
  // 满屏时那一次重画会在末尾留下空白行，所以这行 trace 是排查「切回来整屏上移」的抓手。
  trace(`resize ${id.slice(0, 4)} ${term.cols}x${term.rows}`);
  void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
  return true;
}

async function attach(id: string) {
  sessionId = id;
  requestedSessionId = id;
  filePanel?.selectSession(id);
  shortcutsUi?.selectSession(id);
  lastSeq = 0;
  pending = [];
  attaching = false;
  // 通道类型决定界面上哪些入口存在（串口没有补全、命令检索与备用屏）。
  // 能力位由后端给（`pty_list` 的 `caps`），这里只按会话类型切换提示文案。
  serialKind = tree.find((session) => session.id === id)?.transport === "serial";
  // 字号跟着会话走：每个会话可以各自放大或缩小
  applyFontSize(tree.find((session) => session.id === id)?.settings.font_size ?? DEFAULT_FONT_SIZE);
  serialStatus = null;
  hexMode = hexBySession.get(id) ?? false;
  notice = "";
  window.clearTimeout(noticeTimer);
  ibHex.hidden = !serialKind;
  ibLog.hidden = !serialKind;
  document.getElementById("ib-actions")!.hidden = !serialKind;
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
  autoGrow();
  overlayDraft = "";
  histIdx = -1;
  histDraft = "";
  persistAnswered();

  // 历史也属于会话：先丢掉上一个会话的缓存，等快照回来再填（L2-02）
  cache = emptyCache(id);
  onHistoryChanged();
  ghostEl.textContent = "";
  currentGhost = "";

  // 上一个会话的画面也必须先清掉：新会话的回放可能是空的（冷会话刚拉起、或清过屏），
  // `resyncScreen` 只在有内容可画时才复位，空快照就什么也不动。
  term.reset();
  // `reset` 只清字形，不清底色矩形缓存：空屏时没人再触发重算，上一会话的选中底色会留着
  resyncBackgrounds();

  // 输入条的形态决定终端有多高：直通模式下它收成 0 高，终端就多出几行。
  // 这一步必须排在 fit + 回放**之前**——以前是回放完才 applyOwnership，于是 resyncScreen
  // 按上一个会话的形态 fit（比如 31 行），回放完成后输入条才收起、高度变回 36 行，
  // 期间给 PTY 连发了两次不同尺寸的 resize。shell 每收一次 SIGWINCH 就重画一次提示符，
  // 满屏时就多出几行空白：切回来看到整屏被顶上去、底部空一块。
  // 取不到归属不影响回放（按上一会话的形态画，后续 ownership 事件会纠正），所以失败只记日志。
  try {
    applyOwnership(await invoke<Ownership>("pty_ownership", { id }));
  } catch (err) {
    log(`取归属失败: ${String(err)}`);
  }
  if (sessionId !== id) return;

  const ok = await resyncScreen(id);
  if (!ok || sessionId !== id) return;

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
    const [sessions, lives, runtimeStates] = await Promise.all([
      invoke<TreeSession[]>("session_tree"),
      invoke<SessionInfo[]>("pty_list"),
      invoke<RuntimeState[]>("session_runtime_states")
    ]);
    tree = sessions;
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

/// 会话列表的批量选择：进入后点行只勾选，不切换会话。
/// 勾选只是 id 的集合，全选/反选/清理失效项都走 `selection.ts` 的纯函数。
let sessSelectMode = false;
let sessSelected = new Set<string>();
/// 批量删除与单条删除一样要二次确认：第一次点只把按钮换成「确认删除（n）」，
/// 5 秒内再点才真的删；改选或超时都会自动收回。
let sessDeleteArmed = false;
let sessDeleteArmTimer: number | undefined;

function disarmSessDelete() {
  sessDeleteArmed = false;
  window.clearTimeout(sessDeleteArmTimer);
  sessDeleteArmTimer = undefined;
}

/// 模式开关、复选框与删除按钮的文案都在这里统一刷，renderTree 每次重画都会调。
function paintSessBulk() {
  sessBulk.hidden = !sessSelectMode;
  sessSelect.classList.toggle("on", sessSelectMode);
  sessSelect.setAttribute("aria-pressed", String(sessSelectMode));
  sessPanel.classList.toggle("selecting", sessSelectMode);
  const n = sessSelected.size;
  sessDeleteSelected.textContent = sessDeleteArmed
    ? t("bulk.deleteConfirm", { n })
    : t("bulk.deleteCount", { n });
  sessDeleteSelected.disabled = n === 0;
}

function setSessSelectMode(on: boolean) {
  if (sessSelectMode === on) {
    paintSessBulk();
    return;
  }
  sessSelectMode = on;
  sessSelected = new Set();
  disarmSessDelete();
  if (on) {
    closePopupMenu();
    // 子栏收着时进入批量模式看不见列表：走标题栏的折叠开关把它展开
    if (sessPanel.classList.contains("collapsed")) {
      (document.getElementById("sess-toggle") as HTMLButtonElement).click();
    }
  }
  renderTree();
}

function toggleSessSelected(id: string) {
  sessSelected = toggleId(sessSelected, id);
  disarmSessDelete();
  renderTree();
}

/// 批量删除选中的会话。当前会话也在其中时才切走：和单条删除的收尾一致，
/// 逐条删除，一条失败不影响其余（失败的只记日志）。
async function deleteSelectedSessions() {
  const ids = tree.filter((session) => sessSelected.has(session.id)).map((session) => session.id);
  if (!ids.length) return;
  const wasActive = ids.includes(sessionId);
  for (const id of ids) {
    try {
      await invoke("pty_close", { id });
    } catch (err) {
      console.warn(`[delete] ${String(err)}`);
    }
  }
  sessSelected = new Set();
  disarmSessDelete();
  await refreshTree();
  if (wasActive) {
    sessionId = "";
    const next = tree[tree.length - 1];
    if (next) await openSession(next.id);
    else await newSession();
  }
  renderTree();
}


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

document.getElementById("term-host")!.addEventListener("contextmenu", (event) => {
  if (!term.hasSelection()) return;
  event.preventDefault();
  event.stopPropagation();
  showTerminalSelectionMenu(term.getSelection(), event.clientX, event.clientY);
});

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
      : session.id === sessionId
        ? !serialStatus || serialStatus.paused || serialStatus.status !== "open"
        : true
    : session.id === sessionId ? paused : pausedBySession.get(session.id) ?? false;

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

  const currentOverride = session.id === sessionId ? own?.override ?? "none" : "none";
  const overridePending = isLive && session.id !== sessionId;
  /// 点的时候再读：异步查到的所有权会改它
  let overrideMode: OverrideMode = currentOverride;
  const overrideItem: PopupItem = {
    label: overridePending
      ? t("sessionSettings.loading")
      : currentOverride === "passthrough" ? t("session.takeover") : t("session.passthrough"),
    title: currentOverride === "passthrough"
      ? t("input.toTakeover")
      : currentOverride === "input_bar" ? t("input.toPassthrough") : t("input.overrideHint"),
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
      void closeSession(session.id);
      return;
    }
  };

  const items: PopupItem[] = [pauseItem, clearItem, overrideItem, renameItem, settingsItem, freezeItem, deleteItem];

  // 后台会话没有本地状态：向它问一次，回来再把标签改对
  if (isLive && session.id !== sessionId) {
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
      overrideItem.label = ownership.override === "passthrough" ? t("session.takeover") : t("session.passthrough");
      overrideItem.title = ownership.override === "passthrough" ? t("input.toTakeover") : t("input.toPassthrough");
      overrideItem.disabled = false;
      menu?.repaint();
    }).catch(() => {});
  }

  menu = showPopupMenu({ x, y }, items, { minWidth: 132 });
}

function renderTree() {
  sessList.textContent = "";
  // 树刷新后已经消失的会话不该继续占着勾选
  sessSelected = pruneIds(sessSelected, tree.map((session) => session.id));
  for (const session of tree) {
    const row = document.createElement("div");
    row.className = "sess-row"
      + ((requestedSessionId || sessionId) === session.id ? " active" : "")
      + (sessSelectMode ? " selecting" : "")
      + (sessSelectMode && sessSelected.has(session.id) ? " selected" : "");
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
    if (sessSelectMode) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "sess-check";
      check.checked = sessSelected.has(session.id);
      check.tabIndex = -1;
      check.setAttribute("aria-label", session.title);
      // 勾选交给复选框自己：点它不要冒泡成「点行」，否则一次点击勾两次
      check.addEventListener("click", (event) => event.stopPropagation());
      check.addEventListener("change", () => toggleSessSelected(session.id));
      row.prepend(check);
    }
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 批量选择时不弹单条会话菜单：这一行现在代表的是「勾选」
      if (!sessSelectMode) showSessionMenu(session, e.clientX, e.clientY);
    });
    row.addEventListener("click", (e) => {
      if (sessSelectMode) {
        // 双击的第二下不再勾选，否则连点两下等于没点
        if (e.detail > 1) return;
        e.preventDefault();
        toggleSessSelected(session.id);
        return;
      }
      closePopupMenu();
      const clicks = e.detail;
      if (clicks > 1) {
        if (clicks === 2 && live.has(session.id)) {
          e.preventDefault();
          void togglePauseFor(session.id, session.transport);
        }
        return; // 双击名称仍交给上面的重命名处理器；会话行双击切换状态
      }
      void openSession(session.id);
    });
    sessList.append(row);
  }
  paintSessBulk();
}

function markSessionActivity(id: string) {
  const session = tree.find((item) => item.id === id);
  if (!session || !live.has(id)) return;
  const connected = session.transport === "serial"
    ? (() => {
        const status = serialStatusBySession.get(id);
        return !!status && !status.paused && status.status === "open";
      })()
    : !(pausedBySession.get(id) ?? false);
  if (!connected) return;

  activityUntilBySession.set(id, Date.now() + SESSION_ACTIVITY_MS);
  const dot = [...sessList.querySelectorAll<HTMLElement>(".sess-row")]
    .find((row) => row.dataset.sessionId === id)?.querySelector<HTMLElement>(".sess-dot");
  dot?.classList.add("activity");

  const previous = activityTimers.get(id);
  if (previous !== undefined) window.clearTimeout(previous);
  activityTimers.set(id, window.setTimeout(() => {
    activityUntilBySession.delete(id);
    activityTimers.delete(id);
    [...sessList.querySelectorAll<HTMLElement>(".sess-row")]
      .find((row) => row.dataset.sessionId === id)?.querySelector<HTMLElement>(".sess-dot")
      ?.classList.remove("activity");
  }, SESSION_ACTIVITY_MS));
}

interface TerminalProfile {
  id: string;
  title: string;
  command: string;
}

let terminalProfiles: TerminalProfile[] = [];

async function showNewMenu() {
  closePopupMenu();
  try {
    terminalProfiles = await invoke<TerminalProfile[]>("terminal_profiles");
  } catch (err) {
    console.warn(`[terminal-profiles] ${String(err)}`);
    terminalProfiles = [];
  }
  showPopupMenu(
    sessNew,
    terminalProfiles.map((profile) => ({
      label: profile.title,
      run: () => void newSession(profile.command)
    })),
    { minWidth: 156 }
  );
}

/// 第一次拉起的会话才量冷启动；之后新开的会话不重写这组数字
async function spawn(id: string | null, cwd: string | null = null, shell: string | null = null): Promise<string> {
  const first = coldStart.pending;
  if (first) {
    coldStart.pending = false;
    coldStart.measuring = true;
    coldStart.spawnStart = performance.now();
  }
  let spawned: string;
  try {
    spawned = await invoke<string>("spawn_session", {
      cols: term.cols,
      rows: term.rows,
      shell,
      cwd,
      sessionId: id
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

async function openSession(id: string) {
  const token = ++sessionSwitchToken;
  requestedSessionId = id;
  renderTree();
  filePanel?.selectSession(id);
  if (id === sessionId && live.has(id)) {
    term.focus();
    return;
  }
  if (!live.has(id)) {
    // 冷会话：用同一个 id 拉起，会话树里的位置与历史不变。
    const known = tree.find((s) => s.id === id);
    if (known?.transport === "serial") {
      // 串口冷会话按工作区里记住的配置重连；目录、Shell 与它无关。
      if (!known.serial) {
        log(`串口会话 ${id.slice(0, 8)} 缺少连接参数，无法重连`);
        return;
      }
      await invoke("spawn_serial_session", { config: known.serial, sessionId: id });
    } else {
      // 后端记住了上次的 CWD，从这里接着开；目录已经不在了就退回默认目录。
      try {
        await spawn(id, known?.cwd ?? null, known?.shell ?? null);
      } catch (err) {
        console.warn(`[open] ${String(err)}，退回默认目录`);
        await spawn(id, null, known?.shell ?? null);
      }
    }
    if (token !== sessionSwitchToken || requestedSessionId !== id) return;
    await refreshTree();
  }
  if (token !== sessionSwitchToken || requestedSessionId !== id) return;
  await attach(id);
  renderTree();
}

async function newSession(shell: string | null = null) {
  const id = await spawn(null, null, shell);
  await refreshTree();
  await attach(id);
  renderTree();
}

/// 新建串口会话。参数来自对话框，错误一路抛回去让对话框显示（端口被占用、
/// 设备不在、波特率越界……），不在这里吞掉。成功返回会话 id，挂载交给调用方：
/// 会话已经建好之后，界面挂载失败不该把对话框留在「创建失败」上（重载页面还能挂回来）。
async function newSerialSession(config: SerialConfig): Promise<string> {
  const id = await invoke<string>("spawn_serial_session", { config, sessionId: null });
  await refreshTree();
  return id;
}

async function closeSession(id: string) {
  const wasActive = id === sessionId;
  await invoke("pty_close", { id });
  await refreshTree();
  // 关掉后台会话不该影响当前会话：只有它确实是当前会话、且期间没被切走时才换下一个
  if (!wasActive || sessionId !== id) return;
  sessionId = "";
  const next = tree[tree.length - 1];
  if (next) await openSession(next.id);
  else await newSession();
  renderTree();
}

/// 冻结会话：结束运行时（终端进程 / 串口句柄）但保留工作区节点、命令历史与屏幕快照。
/// 点这一行会按原参数重新拉起，和冷会话的恢复路径完全一样。
async function freezeSession(id: string) {
  const wasActive = id === sessionId;
  try {
    await invoke("pty_freeze", { id });
  } catch (err) {
    console.warn(`[freeze] ${String(err)}`);
    return;
  }
  await refreshTree();
  if (!wasActive || sessionId !== id) return;
  // 当前会话被冻结：切到别的会话；不能选它自己，否则 openSession 会立刻又拉起来
  sessionId = "";
  const next = [...tree].reverse().find((session) => session.id !== id);
  if (next) await openSession(next.id);
  else await newSession();
  renderTree();
}

async function boot() {
  await refreshTree();
  if (!tree.length) {
    await newSession();
    return;
  }
  const last = [...tree].reverse().find((session) => session.transport === "terminal");
  if (!last) {
    await newSession();
    return;
  }
  await openSession(last.id);
  log(`会话 ${tree.length} 个 · 当前 ${last.title}`);
}

sessNew.addEventListener("click", () => void showNewMenu());

// 会话列表的多选：标题栏按钮切换模式，操作栏负责全选/反选/批量删除
sessSelect.addEventListener("click", () => setSessSelectMode(!sessSelectMode));
sessSelectDone.addEventListener("click", () => setSessSelectMode(false));
sessSelectAll.addEventListener("click", () => {
  sessSelected = selectAllIds(tree.map((session) => session.id));
  disarmSessDelete();
  renderTree();
});
sessSelectInvert.addEventListener("click", () => {
  sessSelected = invertIds(sessSelected, tree.map((session) => session.id));
  disarmSessDelete();
  renderTree();
});
sessDeleteSelected.addEventListener("click", () => {
  if (!sessSelected.size) return;
  if (!sessDeleteArmed) {
    sessDeleteArmed = true;
    window.clearTimeout(sessDeleteArmTimer);
    sessDeleteArmTimer = window.setTimeout(() => {
      disarmSessDelete();
      if (sessSelectMode) renderTree();
    }, DELETE_CONFIRM_MS);
    renderTree();
    return;
  }
  void deleteSelectedSessions();
});


/// xterm 的 onData 里有真按键，也有终端回报。焦点报告（`ESC[I` / `ESC[O`）不是用户输入：
/// 原样写进 PTY 会被 PSReadLine 当成按键（响一声、还可能整屏重画）。摘法见 ptyInput.ts。
term.onData((data) => {
  if (!sessionId) return;
  const typed = stripFocusReports(data);
  if (!typed) return;
  trace(`send ${JSON.stringify(typed)}`);
  void invoke("pty_write", { id: sessionId, data: typed });
});

term.onBell(() => trace("BEL fired in xterm"));

let resizeTimer: number | undefined;
/// 布局变化后同步终端尺寸；输入条切换采用瞬时布局，避免动画期间反复触发重排。
function syncSize() {
  if (document.body.classList.contains(DRAGGING_CLASS)) return;
  fit.fit();
  if (!sessionId) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    void invoke("pty_resize", { id: sessionId, cols: term.cols, rows: term.rows });
  }, 60);
}

// 终端容器尺寸一变就让画布跟上：拖窗口、折叠面板都会走这里。
// WebGL 画布是独立合成层，晚一帧就会把旧尺寸的画面画到旁边；ResizeObserver 在布局后、
// 绘制前触发，正好补上这个空档，也比在每个改布局的地方各挂一次 fit 更不容易漏。
new ResizeObserver(() => syncSize()).observe(document.getElementById("term-host") as HTMLElement);

window.addEventListener("resize", syncSize);

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

const STATE_TEXT: Record<TermState, string> = {
  unknown: "",
  prompt_guess: "",
  prompt_ready: "",
  running: "",
  alt_screen: ""
};

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
    if (sessionId !== id || token !== rebuildSeq) return; // 附着途中又切走了 / 已有更新的一份
    cache = fromSnapshot(snap);
  } catch (err) {
    console.warn(`[history] ${String(err)}`);
    if (sessionId !== id || token !== rebuildSeq) return;
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
    const cs = getComputedStyle(ib);
    ghostRuler.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const width = ghostRuler.measureText(value).width;
    // 长命令会把输入框滚起来：建议要跟着可见文本的末端走，不能按逻辑行首定位
    ghostEl.style.left = `${ib.offsetLeft + parseFloat(cs.paddingLeft || "0") + width - ib.scrollLeft}px`;
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
  trace(`overlay open attempt hidden=${histOverlay.hidden ? 1 : 0} session=${sessionId ? 1 : 0}`);
  if (!sessionId || !histOverlay.hidden) return;
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
    autoGrow();
  }
  if (!focusInput) return;
  ib.focus();
  const end = ib.value.length;
  ib.setSelectionRange(end, end);
  updateGhost();
}

async function runFullSearch(token: number) {
  const id = sessionId;
  if (!id || histOverlay.hidden || token !== searchToken) return;
  try {
    const hits = await invoke<HistoryItem[]>("history_search", { id, query: histQuery.value });
    if (histOverlay.hidden || token !== searchToken || sessionId !== id) return;
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
  const id = sessionId;
  if (!id) return;
  void invoke("history_clear", { id }).then(() => {
    void rebuildHistory(id);
    // 点完按钮焦点留在按钮上，不还给搜索框的话接下来的 ↑↓ 和检索都没反应
    if (!histOverlay.hidden) histQuery.focus();
  });
});

histOverlay.addEventListener("mousedown", (e) => e.stopPropagation());

/// 焦点正被别的界面占用时，所有权变化不该抢回来：模态对话框与历史检索面板都算。
function blocksOwnershipFocus(): boolean {
  if (!histOverlay.hidden) return true;
  for (const id of ["settings-overlay", "shortcut-overlay", "serial-overlay"]) {
    const el = document.getElementById(id);
    if (el && !(el as HTMLElement).hidden) return true;
  }
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
  if (!blocksOwnershipFocus() && (active === ib || active === term.textarea || (!editable && transient))) {
    if (takes) ib.focus();
    else term.focus();
  }
  if (changed) {
    console.log(`[own] ${next.state}/${next.owner}/${next.confidence} override=${next.override}`);
  }
  updateGhost();
}

async function setOverrideFor(id: string, mode: Exclude<OverrideMode, "none">) {
  let current: OverrideMode = id === sessionId && own?.id === id ? own.override : "none";
  if (id !== sessionId) {
    try {
      current = (await invoke<Ownership>("pty_ownership", { id })).override;
    } catch (err) {
      console.warn(`[ownership] ${String(err)}`);
      return;
    }
  }
  try {
    await invoke("pty_set_override", { id, mode: current === mode ? "none" : mode });
    if (id === sessionId) applyOwnership(await invoke<Ownership>("pty_ownership", { id }));
  } catch (err) {
    console.warn(`[ownership] ${String(err)}`);
  }
}

function toggleOverride(mode: Exclude<OverrideMode, "none">) {
  if (sessionId) void setOverrideFor(sessionId, mode);
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
const hexBySession = new Map<string, boolean>();

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

  bar.classList.toggle("serial", serialKind);
  bar.classList.toggle("failed", serialKind && serialStatus?.status === "failed");
  bar.classList.toggle("paused", serialKind ? !!serialStatus?.paused : paused);

  // 串口的状态点：连上=绿、主动断开=琥珀、读写失败=红。终端的点只表达所有权。
  dot.classList.toggle("err", serialKind && serialStatus?.status === "failed");
  dot.classList.toggle("warn", serialKind && (!serialStatus || serialStatus.paused || serialStatus.status === "released"));
  dot.classList.toggle("ok", serialKind && serialStatus?.status === "open" && takes);

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
    labelText = STATE_TEXT[own?.state ?? "unknown"];
  }
  ownLabel.textContent = labelText;
  ownLabel.hidden = true;
  ibOverride.textContent = own?.override === "passthrough" ? t("session.takeover") : t("session.passthrough");
  ibOverride.title = own?.override === "passthrough" ? t("input.toTakeover") : t("input.toPassthrough");

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
  if (sessionId !== id || (pauseStateRevision.get(id) ?? 0) !== revision) return;
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
    if (sessionId === id) {
      serialStatus = next;
      paused = next.paused;
    }
  } catch (err) {
    console.warn(`[serial] ${String(err)}`);
    serialStatusBySession.delete(id);
    if (sessionId === id) serialStatus = null;
  }
  renderTree();
  if (sessionId === id) renderBarStatus();
}

/// 暂停 = 冻结画面但不丢数据：后端照常把输出记进回放缓冲，只是不再推事件。
/// 继续时整屏按回放重画一次——只把后续增量画在旧屏幕上会与 Shell 的屏幕错位
/// （它以为光标在某一行，实际早就不是了）。
///
/// 串口会话的同一个按钮是「断开 / 连接」：断开真的关掉端口句柄（别的程序能用），
/// 连接按原配置重开并起新的读线程。回放与历史都不动，所以不必重画屏幕。
async function togglePauseFor(id: string, transport: TreeSession["transport"]) {
  if (transport === "serial") {
    let status = id === sessionId ? serialStatus : null;
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
      if (id === sessionId) showNotice(t("input.connectFailed") + ": " + String(err), true, 8000);
      else console.warn(`[serial] ${String(err)}`);
    }
    if (id === sessionId) await syncSerial(id);
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
    if (id === sessionId) {
      paused = next;
      renderBarStatus();
      if (next) flushOut();
      else await resyncScreen(id);
    }
  } catch (err) {
    console.warn(`[pause] ${String(err)}`);
  } finally {
    pauseOperations.delete(operationKey);
  }
}

async function togglePause() {
  if (!sessionId) return;
  await togglePauseFor(sessionId, serialKind ? "serial" : "terminal");
}

/// 清窗口：屏幕、回放缓冲、磁盘上的卷轴快照一起清，进程与命令历史不动。
/// 不往 Shell 发 Ctrl+L：跑着 logcat 之类时那不是「清屏」而是往 stdin 塞控制字符。
/// 代价是 Shell 仍以为屏幕上有内容，全屏程序（vim / less）要它们自己的 Ctrl+L 重画。
async function clearScreenFor(id: string) {
  if (!id) return;
  const wasActive = id === sessionId;
  let lastCleared = 0;
  try {
    lastCleared = await invoke<number>("pty_clear", { id });
  } catch (err) {
    console.warn(`[clear] ${String(err)}`);
    return;
  }
  if (!wasActive || sessionId !== id) return;
  dropOutQueue();
  outFloor = Math.max(outFloor, lastCleared);
  lastSeq = Math.max(lastSeq, lastCleared);
  noteAnswered(id, lastCleared);
  const transport = tree.find((session) => session.id === id)?.transport ?? "terminal";
  if (clearDisplayMode(transport) === "reset") {
    term.reset();
    resyncBackgrounds();
  } else {
    term.clear();
  }
}

async function clearScreen() {
  if (sessionId) await clearScreenFor(sessionId);
}

for (const btn of [ibHex, ibLog]) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

/// HEX 模式：只改「这次发送怎么读」，不改变输入内容。解析与拒绝原因都在核心。
ibHex.addEventListener("click", () => {
  if (!serialKind || !sessionId) return;
  hexMode = !hexMode;
  hexBySession.set(sessionId, hexMode);
  ibHex.classList.toggle("on", hexMode);
  ib.placeholder = serialKind
    ? hexMode ? t("input.placeholderHex") : t("input.placeholderSerial")
    : t("input.placeholder");
  if (hexMode) {
    ib.value = normalizeHexInput(ib.value);
    autoGrow();
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
    // 串口对话框开着时，按键属于表单：Esc 关闭、Enter 提交都由它自己处理，
    // 不能让 Ctrl+Shift+P / Ctrl+R 之类在对话框里生效。
    if (serialDialog?.isOpen()) return;
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
      const activeSession = tree.some((session) => session.id === sessionId) && live.has(sessionId);
      if (!serialKind && (!activeSession || own?.owner === "input_bar" || !histOverlay.hidden)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // 长按只开/关一次，别让覆盖层闪成跑马灯
        if (histOverlay.hidden) openHistoryOverlay();
        else closeHistoryOverlay(true);
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
function sendLine(line: string) {
  const id = sessionId;
  if (!id) return;
  if (serialKind && hexMode) {
    const clean = normalizeHexInput(line).replaceAll(" ", "");
    if (clean.length % 2 !== 0) {
      ib.value = line;
      autoGrow();
      ib.setSelectionRange(ib.value.length, ib.value.length);
      showNotice(t("input.hexOdd"), true);
      return;
    }
    line = normalizeHexInput(clean);
  }
  const hex = serialKind && hexMode;
  void invoke("pty_send_line", { id, line, hex }).then(
    () => {
      if (noticeIsError && sessionId === id) {
        notice = "";
        noticeIsError = false;
        window.clearTimeout(noticeTimer);
        renderBarStatus();
      }
    },
    (err) => {
      if (sessionId !== id) return;
      if (!ib.value) ib.value = line;
      renderSendAvailability();
      autoGrow();
      ib.setSelectionRange(ib.value.length, ib.value.length);
      showNotice(String(err), true, 8000);
      if (serialKind) void syncSerial(id);
    }
  );
}

async function executeShortcut(command: string): Promise<void> {
  const id = sessionId;
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
    if (stillPaused || sessionId !== id) throw new Error(t("input.paused"));
  }
  await invoke("pty_write", { id, data: `${command}\r` });
}

function fillShortcut(command: string) {
  const id = sessionId;
  if (!id) return;
  const applyFill = () => fillInputBar(command);
  if (own?.id === id && own.override === "passthrough") {
    void invoke("pty_set_override", { id, mode: "input_bar" })
      .then(() => invoke<Ownership>("pty_ownership", { id }))
      .then((ownership) => { if (sessionId === id) { applyOwnership(ownership); applyFill(); } })
      .catch((err) => showNotice(`切回输入模式失败：${String(err)}`, true));
    return;
  }
  applyFill();
}

async function sendInput() {
  const line = ib.value;
  if (!line.trim()) return; // 空白回车不发：后端本来也不记，只是白多打一次提示符

  const id = sessionId;
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
    if (stillPaused || sessionId !== id) return;
  }

  ib.value = "";
  renderSendAvailability();
  autoGrow();
  histIdx = -1;
  histDraft = "";
  sendLine(line);
  updateGhost();
}

function autoGrow() {
  // Input height is controlled by the draggable bar, not by content updates.
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
    autoGrow();
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
    autoGrow();
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
    autoGrow();
    ib.setSelectionRange(ib.value.length, ib.value.length);
    updateGhost();
  } else if (e.key === "Escape") {
    e.preventDefault();
    ib.value = "";
    renderSendAvailability();
    autoGrow();
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
  autoGrow();
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
let outQueue: OutChunk[] = [];
/// 小于等于它的块属于「清屏前」：清屏后即使已经在路上、已经排队，也不再画到空屏上。
let outFloor = 0;
let outTimer: number | undefined;

/// 丢弃还没画的块（切会话时用）：它们属于上一个屏幕，画上去只会污染新会话。
function dropOutQueue() {
  if (outTimer !== undefined) {
    window.clearTimeout(outTimer);
    outTimer = undefined;
  }
  outQueue.length = 0;
}

function flushOut() {
  if (outTimer !== undefined) {
    window.clearTimeout(outTimer);
    outTimer = undefined;
  }
  if (!outQueue.length) return;
  const chunks = outQueue;
  outQueue = [];
  // 清屏那一刻可能还有旧块在路上：按序号把它们滤掉，只画真正在清屏之后产生的块
  const { parts, lastSeq: seq } = keepAfter(chunks, outFloor);
  if (!parts.length) return;
  const id = sessionId;
  term.write(parts.join(""));
  // 画过即答过：终端查询的应答就在这次写入里发生
  if (id && seq) noteAnswered(id, seq);
}

function queueOut(data: string, seq: number) {
  if (seq <= outFloor) return; // 清屏前的块，直接丢
  outQueue.push({ data, seq });
  // 异常爆发时不等帧：先画出来，别把内存堆掉
  if (outQueue.length >= OUT_MAX_PENDING) {
    flushOut();
    return;
  }
  if (outTimer === undefined) {
    outTimer = window.setTimeout(flushOut, OUT_FLUSH_MS);
  }
}

const listenOut = listen<{ id: string; seq: number; data: string }>("pty:out", (event) => {
  const payload = event.payload;
  markSessionActivity(payload.id);
  if (payload.id !== sessionId) return;
  // 先在本地排队，等回放落地再按 seq 去重补上
  if (attaching) {
    pending.push({ seq: payload.seq, data: payload.data });
    return;
  }
  if (payload.seq <= lastSeq) return;
  lastSeq = payload.seq;
  noteFirstOutput();
  bytes += payload.data.length;
  queueOut(payload.data, payload.seq);
});

/// 冷启动计量只认第一次输出；挂回旧会话时 coldStart.measuring 为假，只补画不计量。
function noteFirstOutput() {
  if (coldStart.firstOutputAt || !coldStart.measuring || sessionId !== coldStart.session) return;
  coldStart.firstOutputAt = performance.now();
  log(`session ${sessionId.slice(0, 8)} · 首个字节 ${Math.round(coldStart.firstOutputAt - t0)}ms`);
  if (location.hash === "#bench" && !benchScheduled) {
    benchScheduled = true;
    window.setTimeout(() => void runBench(), 1500);
  }
}

const listenExit = listen<{ id: string }>("pty:exit", (event) => {
  if (event.payload.id !== sessionId) {
    void refreshTree();
    return;
  }
  flushOut();
  term.writeln("\r\n\x1b[38;5;245m[进程已退出]\x1b[0m");
  void refreshTree();
});

const listenOwn = listen<Ownership>("pty:ownership", (event) => {
  if (event.payload.id !== sessionId) return;
  applyOwnership(event.payload);
});

// 串口状态：连上 / 主动断开 / 读写失败。后端只在变化时发，前端只负责画。
const listenSerial = listen<SerialStatus>("serial:status", (event) => {
  serialStatusBySession.set(event.payload.id, event.payload);
  if (event.payload.id === sessionId) {
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
  const outcome = applyAppend(cache, sessionId, event.payload);
  if (outcome.kind === "rebuild") {
    void rebuildHistory(sessionId); // 跳号 / 缓存还没为该会话建好：整份重建，不逐条修补
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
      `1MB ${flood.ms}ms (${flood.mbs} MB/s) · webgl ${webgl ? "on" : "off"}`;
    log(text);
    void invoke("bench_report", { text });
  } catch (err) {
    log("基准失败: " + String(err));
  }
}

// 左栏先装配：文件面板的宽度上限要量它当前多宽，顺序反了第一帧会算错
setupSidebarHandle = setupSidebar({ layoutChanged: () => syncSize() });
setupInputbarResize({ layoutChanged: () => syncSize() });

filePanel = setupFilePanel({
  sessionId: () => sessionId,
  cwdOf: (id) => tree.find((session) => session.id === id)?.cwd ?? null,
  fillInput: (text) => fillInputBar(text),
  layoutChanged: () => syncSize()
});

// 自绘标题栏：窗口按钮 + 左右栏折叠。两栏都已装配完，这里拿它们的句柄接线。
const filePanelHandle = filePanel;
setupTitlebar({
  left: setupSidebarHandle,
  right: filePanelHandle
});

sessionSettingsUi = setupSessionSettingsUi({
  saved: async (id) => {
    await refreshTree();
    if (id === sessionId) {
      filePanel?.onCwd(id);
      applyFontSize(tree.find((session) => session.id === id)?.settings.font_size ?? DEFAULT_FONT_SIZE);
    }
  },
  fontSizePreview: (id, size) => {
    if (id === sessionId) applyFontSize(size);
  }
});

shortcutsUi = setupShortcutsUi({
  sessionId: () => sessionId,
  fill: fillShortcut,
  execute: executeShortcut,
  layoutChanged: () => syncSize()
});

// 串口对话框：创建成功才关闭，失败把后端的原因原样显示在表单里
serialDialog = setupSerialDialog({
  create: async (config) => {
    const id = await newSerialSession(config);
    // 建好的会话已经进了工作区：挂载失败只记日志，别让对话框假装没创建成功
    void attach(id)
      .then(() => renderTree())
      .catch((err) => console.warn(`[serial] attach: ${String(err)}`));
    return "";
  }
});

setupSerialPortsPanel({ open: (port) => { if (port) serialDialog?.open(port); } });

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
