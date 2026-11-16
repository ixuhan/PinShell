import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const t0 = performance.now();
const hud = document.getElementById("hud") as HTMLDivElement;
const bar = document.getElementById("inputbar") as HTMLDivElement;
const dot = document.getElementById("own-dot") as HTMLSpanElement;
const ownLabel = document.getElementById("own-label") as HTMLSpanElement;
const ib = document.getElementById("ib-input") as HTMLInputElement;

function log(msg: string) {
  hud.textContent = msg;
  console.log(msg);
}

const term = new Terminal({
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  scrollback: 10000,
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
let firstOutputAt = 0;
/// 提示符就绪（OSC 133 A）到达前端的时刻。「首字节」不是可输入时刻，见 docs/bench-m0.md
let inputReadyAt = 0;
let bytes = 0;
let benchTerm: Terminal | null = null;
let benchScheduled = false;
let tSpawnStart = 0;
let tSpawnReturn = 0;

async function boot() {
  term.writeln("\x1b[38;5;245m启动会话…\x1b[0m");
  const cols = term.cols;
  const rows = term.rows;
  tSpawnStart = performance.now();
  sessionId = await invoke<string>("spawn_session", { cols, rows, shell: null, cwd: null });
  tSpawnReturn = performance.now();
  term.focus();
  // 首帧判定可能在订阅生效前就发出去了，这里补一帧
  applyOwnership(await invoke<Ownership>("pty_ownership", { id: sessionId }));
  void refreshHistory();
  log(
    `bench: 前端就绪 ${Math.round(tSpawnStart - t0)}ms · spawn 调用 ${Math.round(tSpawnReturn - tSpawnStart)}ms`
  );
}

term.onData((data) => {
  if (!sessionId) return;
  void invoke("pty_write", { id: sessionId, data });
});

let resizeTimer: number | undefined;
function syncSize() {
  if (!sessionId) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    fit.fit();
    void invoke("pty_resize", { id: sessionId, cols: term.cols, rows: term.rows });
  }, 60);
}
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

// 输入条历史：后端保存，前端只在内存里做 ↑↓ 导航
let hist: string[] = [];
let histIdx = -1;
let histDraft = "";

async function refreshHistory() {
  if (!sessionId) return;
  try {
    hist = await invoke<string[]>("pty_history", { id: sessionId });
  } catch {
    hist = [];
  }
  histIdx = -1;
  histDraft = "";
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

  dot.className = guess ? "guess" : takes ? "ok" : "";
  bar.className = takes ? "ok" : guess ? "guess" : "pass";
  ownLabel.textContent =
    next.override === "passthrough"
      ? "已锁直通 · 按键全给终端"
      : next.override === "input_bar"
        ? "已锁输入条 · 按键不回终端"
        : STATE_TEXT[next.state];

  // 可输入的判定口径：OSC 133 A 推进到 prompt_ready 的那一刻。
  // 只记第一次，后续提示符漂移不改写冷启动数字。
  if (!inputReadyAt && next.state === "prompt_ready") {
    inputReadyAt = performance.now();
    const ms = Math.round(inputReadyAt - t0);
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
}

function setOverride(mode: OverrideMode) {
  if (!sessionId) return;
  void invoke("pty_set_override", { id: sessionId, mode });
}

function toggleOverride(mode: Exclude<OverrideMode, "none">) {
  setOverride(own?.override === mode ? "none" : mode);
}

// 快捷键放在捕获阶段，避免 xterm 先吃掉按键
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.code === "KeyP") {
      e.preventDefault();
      e.stopPropagation();
      toggleOverride("passthrough");
    } else if (e.code === "KeyL") {
      e.preventDefault();
      e.stopPropagation();
      toggleOverride("input_bar");
    }
  },
  true
);

// 输入条是命令的唯一入口：只发「文本 + 回车」，状态推进仍由后端负责
function sendLine(line: string) {
  if (!sessionId) return;
  void invoke("pty_send_line", { id: sessionId, line }).then(refreshHistory);
}

ib.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const line = ib.value;
    ib.value = "";
    sendLine(line);
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
  } else if (e.key === "Escape") {
    e.preventDefault();
    ib.value = "";
    histIdx = -1;
    histDraft = "";
  } else if (e.key === "Tab") {
    // 还没有补全，先把 Tab 占住，别让它把焦点送出输入条
    e.preventDefault();
  }
});

// 输出按帧聚合：来一块就画一块会在 vim 全屏重绘时掉帧（见 docs/bench-m0.md）
const OUT_FLUSH_MS = 16;
const OUT_MAX_PENDING = 512;
let outQueue: string[] = [];
let outTimer: number | undefined;

function flushOut() {
  if (outTimer !== undefined) {
    window.clearTimeout(outTimer);
    outTimer = undefined;
  }
  if (!outQueue.length) return;
  const chunk = outQueue.join("");
  outQueue.length = 0;
  term.write(chunk);
}

function queueOut(data: string) {
  outQueue.push(data);
  // 异常爆发时不等帧：先画出来，别把内存堆掉
  if (outQueue.length >= OUT_MAX_PENDING) {
    flushOut();
    return;
  }
  if (outTimer === undefined) {
    outTimer = window.setTimeout(flushOut, OUT_FLUSH_MS);
  }
}

const listenOut = listen<{ id: string; data: string }>("pty:out", (event) => {
  if (event.payload.id !== sessionId) return;
  if (!firstOutputAt) {
    firstOutputAt = performance.now();
    log(`session ${sessionId.slice(0, 8)} · 首个字节 ${Math.round(firstOutputAt - t0)}ms`);
  }
  if (!benchScheduled) {
    benchScheduled = true;
    window.setTimeout(() => void runBench(), 1500);
  }
  bytes += event.payload.data.length;
  queueOut(event.payload.data);
});

const listenExit = listen<{ id: string }>("pty:exit", (event) => {
  if (event.payload.id !== sessionId) return;
  flushOut();
  term.writeln("\r\n\x1b[38;5;245m[进程已退出]\x1b[0m");
});

const listenOwn = listen<Ownership>("pty:ownership", (event) => {
  if (event.payload.id !== sessionId) return;
  applyOwnership(event.payload);
});

// 页面重载 / 关闭窗口时结束会话，避免留下孤儿进程
window.addEventListener("beforeunload", () => {
  if (sessionId) void invoke("pty_close", { id: sessionId });
});

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
      firstByteMs: firstOutputAt ? Math.round(firstOutputAt - t0) : null,
      inputReadyMs: inputReadyAt ? Math.round(inputReadyAt - t0) : null
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
    const ready = inputReadyAt
      ? `可输入 ${Math.round(inputReadyAt - t0)}ms`
      : "可输入 未就绪";
    const text =
      `前端 ${Math.round(tSpawnStart - t0)}ms + spawn ${Math.round(tSpawnReturn - tSpawnStart)}ms + ` +
      `${ready}（首字节 ${Math.round(firstOutputAt - tSpawnReturn)}ms） · IPC p50 ${ping.p50}ms/p99 ${ping.p99}ms · ` +
      `1MB ${flood.ms}ms (${flood.mbs} MB/s) · webgl ${webgl ? "on" : "off"}`;
    log(text);
    void invoke("bench_report", { text });
  } catch (err) {
    log("基准失败: " + String(err));
  }
}

void Promise.all([listenOut, listenExit, listenOwn]).then(boot);
