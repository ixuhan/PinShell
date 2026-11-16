import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const t0 = performance.now();
const hud = document.getElementById("hud") as HTMLDivElement;

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

listen<{ id: string; data: string }>("pty:out", (event) => {
  if (event.payload.id !== sessionId) return;
  if (!firstOutputAt) {
    firstOutputAt = performance.now();
    log(`session ${sessionId.slice(0, 8)} · 首个输出 ${Math.round(firstOutputAt - t0)}ms`);
  }
  if (!benchScheduled) {
    benchScheduled = true;
    window.setTimeout(() => void runBench(), 1500);
  }
  bytes += event.payload.data.length;
  queueOut(event.payload.data);
});

listen<{ id: string }>("pty:exit", (event) => {
  if (event.payload.id !== sessionId) return;
  flushOut();
  term.writeln("\r\n\x1b[38;5;245m[进程已退出]\x1b[0m");
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

  /** 冷启动：从模块求值到首个 PTY 输出 */
  coldStart() {
    return { sinceModuleEvalMs: firstOutputAt ? Math.round(firstOutputAt - t0) : null };
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
    const text =
      `前端 ${Math.round(tSpawnStart - t0)}ms + spawn ${Math.round(tSpawnReturn - tSpawnStart)}ms + ` +
      `首字节 ${Math.round(firstOutputAt - tSpawnReturn)}ms · IPC p50 ${ping.p50}ms/p99 ${ping.p99}ms · ` +
      `1MB ${flood.ms}ms (${flood.mbs} MB/s) · webgl ${webgl ? "on" : "off"}`;
    log(text);
    void invoke("bench_report", { text });
  } catch (err) {
    log("基准失败: " + String(err));
  }
}

void boot();
