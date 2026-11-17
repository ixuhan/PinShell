// 卷轴行数上限（xterm 的 `scrollback`）的实测：稳态吞吐 + 留住的缓冲内存。
//
// 只跑 xterm 的核心缓冲，不 open()，因此不含 DOM 与 WebGL —— 渲染只画视口那几十行，
// 与上限无关；这里量的是「解析 + 行缓冲保留」的真实成本，也就是设上限的理由。
//
// 用法：node --expose-gc scripts/bench-scrollback.mjs [行数...]
// 默认 1000 5000 10000 50000。每个上限单独起一个子进程：同进程连跑会让上一轮的
// 垃圾混进下一轮的堆差值，量出来的内存能差一倍。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIMITS = [1000, 5000, 10000, 50000];
const TOTAL_MB = 8;
const COLS = 120;
// 每行 57 个字符：8 MB 装得下 129k 行，足以把 50000 行的上限灌满
const LINE = "0123456789abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";

if (process.argv[2] === "--child") {
  const { Terminal } = (await import("@xterm/xterm")).default;
  const scrollback = Number(process.argv[3] ?? 5000);
  const payload = LINE.repeat(Math.ceil((TOTAL_MB * 1024 * 1024) / LINE.length));

  const heap = () => {
    global.gc?.();
    global.gc?.();
    return process.memoryUsage().heapUsed;
  };

  // 预热：把 8 MB 输入串拍平、让 xterm 的惰性初始化先发生一次，
  // 否则第一轮的堆差值会把输入串自己的分配算进缓冲里
  {
    const warm = new Terminal({ cols: COLS, rows: 40, scrollback: 100 });
    await new Promise((resolve) => warm.write(payload.slice(0, 4096), resolve));
    warm.dispose();
  }

  const base = heap();
  const term = new Terminal({ cols: COLS, rows: 40, scrollback });
  const started = performance.now();
  await new Promise((resolve) => term.write(payload, resolve));
  const fillMs = performance.now() - started;
  // 灌满后再来一轮：这一轮才是「持续刷屏」的稳态成本，与上限几乎无关
  const steadyStart = performance.now();
  await new Promise((resolve) => term.write(payload, resolve));
  const steadyMs = performance.now() - steadyStart;
  const retained = heap() - base;
  const lines = term.buffer.active.length;

  console.log(
    JSON.stringify({
      scrollback,
      lines,
      fillMs: Math.round(fillMs),
      steadyMs: Math.round(steadyMs),
      mbPerSec: +(TOTAL_MB / (steadyMs / 1000)).toFixed(1),
      retainedMB: +(retained / 1048576).toFixed(2),
      kbPerLine: +(retained / lines / 1024).toFixed(2)
    })
  );
  process.exit(0);
}

const limits = process.argv.slice(2).map(Number).filter(Boolean);
const rows = [];
for (const limit of limits.length ? limits : LIMITS) {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", fileURLToPath(import.meta.url), "--child", String(limit)],
    { encoding: "utf8" }
  );
  if (child.status !== 0) {
    console.error(`scrollback=${limit} 失败：${child.stderr || child.status}`);
    process.exit(1);
  }
  rows.push(JSON.parse(child.stdout.trim()));
}

const pad = (text, width) => String(text).padStart(width);
console.log(
  `${pad("scrollback", 12)} ${pad("行数", 8)} ${pad("灌满", 8)} ${pad("稳态", 8)} ${pad("吞吐", 11)} ${pad("留住的缓冲", 12)}`
);
for (const row of rows) {
  console.log(
    `${pad(row.scrollback, 12)} ${pad(row.lines, 8)} ${pad(`${row.fillMs}ms`, 8)} ` +
      `${pad(`${row.steadyMs}ms`, 8)} ${pad(`${row.mbPerSec} MB/s`, 11)} ` +
      `${pad(`${row.retainedMB} MB`, 12)} (${row.kbPerLine} KB/行)`
  );
}
