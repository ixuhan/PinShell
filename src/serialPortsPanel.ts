// 端口面板的纯逻辑：列表比较与轮询节拍。无 DOM、无 IPC（L0）。
//
// 刷新机制与文件面板（`filePanel.ts`）同一套：开关打开先立刻扫一次，
// 之后「上次扫完再等一个周期」；失败按 2^n 退避；面板折叠或窗口隐藏时不扫。
// 串口的枚举很便宜，但每秒一次也会打扰别的调用方，规则不值得另写一份。

import type { SerialPort } from "./serialUi";

/// 自动扫描周期。
export const POLL_MS = 1000;
/// 连续失败时的退避上限；串口基础周期为 1 秒，实际最多等待 8 秒。
export const MAX_BACKOFF_MS = 24000;

/// 两次枚举结果是否完全一样。内容没变就不重建列表，
/// 选中的行、滚动位置都不被每秒一次的轮询打断。
export function samePorts(previous: SerialPort[] | null, next: SerialPort[]): boolean {
  if (!previous) return false;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (
      a.port !== b.port ||
      a.kind !== b.kind ||
      a.vid !== b.vid ||
      a.pid !== b.pid ||
      a.manufacturer !== b.manufacturer ||
      a.product !== b.product ||
      a.serial_number !== b.serial_number ||
      a.friendly_name !== b.friendly_name
    ) {
      return false;
    }
  }
  return true;
}

/// 与文件面板一样最多退避三档，串口基础周期为 1 秒，实际最大等待 8 秒。
/// 枚举失败通常是驱动或权限问题，每秒重试只会刷屏报错。
export function pollDelay(failures: number): number {
  if (failures <= 0) return POLL_MS;
  return Math.min(POLL_MS * 2 ** Math.min(failures, 3), MAX_BACKOFF_MS);
}

export interface PortPollingDeps {
  read(): Promise<SerialPort[]>;
  result(ports: SerialPort[]): void;
  error(error: unknown): void;
  canAuto(): boolean;
}

// 手动刷新与自动轮询共用在途请求，每次完成后才计时。
export function createPortPolling(deps: PortPollingDeps) {
  let auto = false;
  let failures = 0;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    stop();
    if (!auto || pending || !deps.canAuto()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (auto && deps.canAuto()) void run();
    }, pollDelay(failures));
  }

  function run(): Promise<void> {
    stop();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => deps.read())
      .then((ports) => {
        failures = 0;
        deps.result(ports);
      }, (error: unknown) => {
        failures = Math.min(failures + 1, 3);
        deps.error(error);
      })
      .finally(() => {
        pending = null;
        schedule();
      });
    return pending;
  }

  return {
    refresh() {
      failures = 0;
      return run();
    },
    setAuto(enabled: boolean) {
      auto = enabled;
      failures = 0;
      if (auto && deps.canAuto()) void run();
      else stop();
    },
    sync: schedule,
    stop
  };
}
