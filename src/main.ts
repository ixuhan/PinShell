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
import { keepAfter, type OutChunk } from "./outQueue";
import { setupFilePanel } from "./filePanelUi";
import { DRAGGING_CLASS } from "./resize";
import { setupSidebar } from "./sidebarUi";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const t0 = performance.now();
const hud = document.getElementById("hud") as HTMLDivElement;
const bar = document.getElementById("inputbar") as HTMLDivElement;
const dot = document.getElementById("own-dot") as HTMLSpanElement;
const ownLabel = document.getElementById("own-label") as HTMLSpanElement;
const ib = document.getElementById("ib-input") as HTMLInputElement;
const ghostEl = document.getElementById("ib-ghost") as HTMLSpanElement;
const sessList = document.getElementById("sess-list") as HTMLDivElement;
const sessNew = document.getElementById("sess-new") as HTMLButtonElement;
const histOverlay = document.getElementById("hist-overlay") as HTMLDivElement;
const histQuery = document.getElementById("hist-query") as HTMLInputElement;
const histList = document.getElementById("hist-list") as HTMLDivElement;
const histCount = document.getElementById("hist-count") as HTMLSpanElement;
const histClearBtn = document.getElementById("hist-clear") as HTMLButtonElement;
const histCloseBtn = document.getElementById("hist-close") as HTMLButtonElement;
const ibPause = document.getElementById("ib-pause") as HTMLButtonElement;
const ibClear = document.getElementById("ib-clear") as HTMLButtonElement;
const ibPass = document.getElementById("ib-pass") as HTMLButtonElement;
const ibTake = document.getElementById("ib-take") as HTMLButtonElement;
const ibPaused = document.getElementById("ib-paused") as HTMLSpanElement;

function log(msg: string) {
  hud.textContent = msg;
  console.log(msg);
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
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  scrollback: SCROLLBACK_LINES,
  allowProposedApi: true
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("term-host") as HTMLElement);
fit.fit();

let webgl = false;
try {
  term.loadAddon(new WebglAddon());
  webgl = true;
} catch {
  webgl = false;
}

let sessionId = "";
let bytes = 0;
/// 文件面板的句柄：监听器可能先于 setup 收到事件，所以允许为空
let filePanel: ReturnType<typeof setupFilePanel> | null = null;
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

interface SessionInfo {
  id: string;
  title: string;
  state: TermState;
  created_ms: number;
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

  lastSeq = snap.seq;
  if (snap.data) {
    // 快照会整屏重画：先复位，免得新内容叠在旧画面上（半屏重影）
    term.reset();
    term.write(snap.data);
    // 这一份画过就等于答过：之后再附着，这部分查询交给后端删掉
    noteAnswered(id, snap.seq);
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
  // 空快照不会让模型发生变化，底色缓存得手动重算一次，否则旧矩形会一直画着
  resyncBackgrounds();
  void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
  return true;
}

async function attach(id: string) {
  sessionId = id;
  lastSeq = 0;
  pending = [];
  attaching = false;
  // 历史覆盖层、输入草稿、↑↓ 游标都属于上一个会话：切走时一起丢掉，
  // 否则旧会话里敲了一半的命令会被回车发到新会话去。
  if (!histOverlay.hidden) closeHistoryOverlay(false, false);
  ib.value = "";
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

  const ok = await resyncScreen(id);
  if (!ok || sessionId !== id) return;

  applyOwnership(await invoke<Ownership>("pty_ownership", { id }));
  await syncPaused(id);
  void rebuildHistory(id);
  // 文件面板跟随会话：切到哪儿就跟到哪儿（固定模式下它自己会忽略这次刷新）
  filePanel?.reload();
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
}

async function refreshTree() {
  try {
    const [sessions, lives] = await Promise.all([
      invoke<TreeSession[]>("session_tree"),
      invoke<SessionInfo[]>("pty_list")
    ]);
    tree = sessions;
    live = new Map(lives.map((s) => [s.id, s]));
  } catch (err) {
    console.warn(`[tree] ${String(err)}`);
  }
  renderTree();
}

/// 正在改名的会话 id。改名是就地编辑，不弹框：双击名字进入，回车提交、Esc 放弃。
let renaming: string | null = null;

function renderTree() {
  sessList.textContent = "";
  for (const session of tree) {
    const row = document.createElement("div");
    row.className = "sess-row" + (session.id === sessionId ? " active" : "");
    row.title = `${session.title} · ${session.id.slice(0, 8)}${session.cwd ? ` · ${session.cwd}` : ""}`;

    const dot = document.createElement("span");
    dot.className = "sess-dot" + (live.has(session.id) ? " hot" : "");

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
      name.title = "双击重命名";
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        renaming = session.id;
        renderTree();
      });
    }

    const close = document.createElement("button");
    close.className = "sess-close";
    close.textContent = "✕";
    close.title = "关闭会话";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeSession(session.id);
    });

    row.append(dot, name, close);
    row.addEventListener("click", (e) => {
      if (e.detail > 1) return; // 双击的第二下属于改名，不该顺带切换会话
      void openSession(session.id);
    });
    sessList.append(row);
  }
}

/// 第一次拉起的会话才量冷启动；之后新开的会话不重写这组数字
async function spawn(id: string | null, cwd: string | null = null): Promise<string> {
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
      shell: null,
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
  if (id === sessionId && live.has(id)) {
    term.focus();
    return;
  }
  if (!live.has(id)) {
    // 冷会话：用同一个 id 拉起，会话树里的位置与历史不变。
    // 后端记住了上次的 CWD，从这里接着开；目录已经不在了就退回默认目录。
    try {
      await spawn(id, tree.find((s) => s.id === id)?.cwd ?? null);
    } catch (err) {
      console.warn(`[open] ${String(err)}，退回默认目录`);
      await spawn(id, null);
    }
    await refreshTree();
  }
  await attach(id);
  renderTree();
}

async function newSession() {
  const id = await spawn(null);
  await refreshTree();
  await attach(id);
  renderTree();
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

async function boot() {
  await refreshTree();
  if (!tree.length) {
    await newSession();
    return;
  }
  const last = tree[tree.length - 1];
  await openSession(last.id);
  log(`会话 ${tree.length} 个 · 当前 ${last.title}`);
}

sessNew.addEventListener("click", () => void newSession());


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
/// 布局变了：先把画布 fit 到当前容器（同步做，等防抖会晚一帧），再把新尺寸防抖下给 PTY。
function syncSize() {
  // 拖左栏或文件面板期间不重排终端：每跨一列就整屏重画一次，看起来就是会话区在闪。
  // 那时画布保持原尺寸、由 #term-host 裁掉多出来的部分，松手时 layoutChanged 再重排一次。
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
  unknown: "未知 · 直通",
  prompt_guess: "猜测 · 直通",
  prompt_ready: "提示符就绪 · 可接管",
  running: "运行中 · 直通",
  alt_screen: "备用屏 · 直通"
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
  histCount.textContent = `${total} 条${total > rows.length ? ` · 显示最近 ${rows.length}` : ""}`;
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "hist-empty";
    empty.textContent = "没有匹配的命令";
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
      older.textContent = "更早";
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
  if (restoreDraft) ib.value = overlayDraft;
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
    histClearBtn.textContent = "再点一次确认";
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearArmed = false;
      histClearBtn.classList.remove("armed");
      histClearBtn.textContent = "清空本会话";
    }, 3000);
    return;
  }
  clearArmed = false;
  window.clearTimeout(clearTimer);
  histClearBtn.classList.remove("armed");
  histClearBtn.textContent = "清空本会话";
  const id = sessionId;
  if (!id) return;
  void invoke("history_clear", { id }).then(() => {
    void rebuildHistory(id);
    // 点完按钮焦点留在按钮上，不还给搜索框的话接下来的 ↑↓ 和检索都没反应
    if (!histOverlay.hidden) histQuery.focus();
  });
});

histOverlay.addEventListener("mousedown", (e) => e.stopPropagation());

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
  // 这两项不是所有权的一部分，但都画在同一条输入条上：重设 className 会把它们抹掉，
  // 所以每次刷新所有权都按当前状态重新贴一遍。
  if (paused) bar.classList.add("paused");
  ibPass.classList.toggle("on", next.override === "passthrough");
  ibTake.classList.toggle("on", next.override === "input_bar");
  ownLabel.textContent =
    next.override === "passthrough"
      ? "已锁直通 · 按键全给终端"
      : next.override === "input_bar"
        ? "已锁输入条 · 按键不回终端"
        : STATE_TEXT[next.state];

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
  // 只在本应用的两个焦点之间搬动，别抢别的控件
  const active = document.activeElement;
  if (active === ib || active === document.body || active === term.textarea) {
    if (takes) ib.focus();
    else term.focus();
  }
  if (changed) {
    console.log(`[own] ${next.state}/${next.owner}/${next.confidence} override=${next.override}`);
  }
  updateGhost();
}

function setOverride(mode: OverrideMode) {
  if (!sessionId) return;
  void invoke("pty_set_override", { id: sessionId, mode });
}

function toggleOverride(mode: Exclude<OverrideMode, "none">) {
  setOverride(own?.override === mode ? "none" : mode);
}

// ---------- 输入条按钮：暂停 / 清屏 / 直通 / 接管 ----------
// 这四个动作此前只有快捷键，鼠标点不到。按钮一律不抢焦点：点完焦点还在终端或输入框，
// 可以接着敲键盘（否则点完「接管」还得再点一次输入框才能打字）。

/// 暂停接收输出。判定在后端读线程（暂停期间不再发 `pty:out`），前端只表达意图与按钮状态。
let paused = false;

function renderPaused() {
  ibPause.classList.toggle("on", paused);
  ibPause.textContent = paused ? "继续" : "暂停";
  ibPaused.hidden = !paused;
  bar.classList.toggle("paused", paused);
}

/// 切会话/切回来时按后端的真实状态复原按钮：暂停是后端的开关，
/// 前端只记「当前会话」的那一份，不能凭上一个会话的记忆画按钮。
async function syncPaused(id: string) {
  let next = false;
  try {
    next = await invoke<boolean>("pty_paused", { id });
  } catch (err) {
    console.warn(`[pause] ${String(err)}`);
  }
  if (sessionId !== id) return; // 查的途中又切走了
  paused = next;
  renderPaused();
}

/// 暂停 = 冻结画面但不丢数据：后端照常把输出记进回放缓冲，只是不再推事件。
/// 继续时整屏按回放重画一次——只把后续增量画在旧屏幕上会与 Shell 的屏幕错位
/// （它以为光标在某一行，实际早就不是了）。
async function togglePause() {
  const id = sessionId;
  if (!id) return;
  const next = !paused;
  if (next) flushOut(); // 暂停前已经到手的块属于「暂停前」，先画完再冻结
  paused = next;
  renderPaused();
  try {
    await invoke("pty_set_paused", { id, paused: next });
  } catch (err) {
    paused = !next;
    renderPaused();
    console.warn(`[pause] ${String(err)}`);
    return;
  }
  // 继续：只重画屏幕，保住输入草稿、历史缓存与覆盖层（切会话才丢这些）
  if (!next && sessionId === id) {
    await resyncScreen(id);
    await syncPaused(id);
  }
}

/// 清窗口：屏幕、回放缓冲、磁盘上的卷轴快照一起清，进程与命令历史不动。
/// 不往 Shell 发 Ctrl+L：跑着 logcat 之类时那不是「清屏」而是往 stdin 塞控制字符。
/// 代价是 Shell 仍以为屏幕上有内容，全屏程序（vim / less）要它们自己的 Ctrl+L 重画。
async function clearScreen() {
  const id = sessionId;
  if (!id) return;
  // 先让后端清回放，再清前端：清屏前读到的块可能已经在 IPC 路上，用返回的序号
  // 把它们拦在空屏之外；反过来先清前端的话，这些块会再画一遍。
  let lastCleared = 0;
  try {
    lastCleared = await invoke<number>("pty_clear", { id });
  } catch (err) {
    console.warn(`[clear] ${String(err)}`);
    return;
  }
  if (sessionId !== id) return; // 清后端的时候又切走了：别把新会话的屏幕清了
  dropOutQueue(); // 队列里全是清屏前的块，序号都小于等于 outFloor，留着也不会画
  outFloor = Math.max(outFloor, lastCleared);
  lastSeq = Math.max(lastSeq, lastCleared);
  noteAnswered(id, lastCleared);
  term.clear(); // 与 `clear` 指令一致：当前行提到首行，历史一起丢
}

for (const btn of [ibPause, ibClear, ibPass, ibTake]) {
  // 不抢焦点：点在按钮上等同于按快捷键
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}
ibPause.addEventListener("click", () => void togglePause());
ibClear.addEventListener("click", () => void clearScreen());
ibPass.addEventListener("click", () => toggleOverride("passthrough"));
ibTake.addEventListener("click", () => toggleOverride("input_bar"));

// 快捷键放在捕获阶段，避免 xterm 先吃掉按键
window.addEventListener(
  "keydown",
  (e) => {
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
      if (own?.owner === "input_bar" || !histOverlay.hidden) {
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

// 输入条是命令的唯一入口：只发「文本 + 回车」，状态推进仍由后端负责
function sendLine(line: string) {
  if (!sessionId) return;
  void invoke("pty_send_line", { id: sessionId, line });
}

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
  if (e.key === "Enter") {
    e.preventDefault();
    const line = ib.value;
    if (!line.trim()) return; // 空白回车不发：后端本来也不记，只是白多打一次提示符
    ib.value = "";
    histIdx = -1;
    histDraft = "";
    sendLine(line);
    updateGhost();
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
    ib.setSelectionRange(ib.value.length, ib.value.length);
    updateGhost();
  } else if (e.key === "Escape") {
    e.preventDefault();
    ib.value = "";
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
  if (!benchScheduled) {
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
setupSidebar({ layoutChanged: () => syncSize() });

filePanel = setupFilePanel({
  sessionId: () => sessionId,
  cwdOf: (id) => tree.find((session) => session.id === id)?.cwd ?? null,
  fillInput: (text) => fillInputBar(text),
  layoutChanged: () => syncSize()
});

void Promise.all([
  listenOut,
  listenExit,
  listenOwn,
  listenCwd,
  listenHistory,
  listenHistoryDegraded
]).then(boot);
