// 文件面板的纯逻辑：显示格式、路径拼接，以及「跟随 / 固定」两种模式下该请求哪个目录。
//
// 这里不做 DOM、不发 IPC：排序与过滤是后端的规则（`core-domain::fsview`），
// 本模块只决定「面板要什么、怎么显示」。

export type FilePanelMode = "follow" | "fixed";

export interface FsEntry {
  name: string;
  kind: "dir" | "file" | "other";
  link: boolean;
  size: number;
  modified_ms: number | null;
  hidden: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  total: number;
  hidden_count: number;
  truncated: boolean;
  entries: FsEntry[];
}

/// 只有普通文件显示大小。目录与其它类型显示空串，避免一排 `0 B`。
export function formatSize(entry: FsEntry): string {
  if (entry.kind !== "file") return "";
  const bytes = entry.size;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/// 当天只显示时分，同年显示月日，跨年显示完整日期。`now` 可注入，方便测试。
export function formatTime(ms: number | null, now = Date.now()): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const ref = new Date(now);
  if (Number.isNaN(date.getTime())) return "";

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  const sameDay =
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth() &&
    date.getDate() === ref.getDate();
  if (sameDay) return `${hh}:${mm}`;
  if (date.getFullYear() === ref.getFullYear()) return `${month}-${day} ${hh}:${mm}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

/// 进入子项。规则与 `core_domain::fsview::child_of` 一致：根后面不补第二个分隔符。
export function joinPath(parent: string, name: string): string {
  const base = parent.replace(/\//g, "\\").replace(/\\+$/, "");
  if (!base) return name;
  return `${base}\\${name}`;
}

/// 该向 `fs_list` 请求哪个路径。
///
/// - 跟随模式返回 `null`：让后端按会话记下的 CWD 取，前端不复制「CWD 是什么」的规则。
/// - 固定模式用当前停留的路径；还没导航过就先用一次 CWD 作为起点。
export function panelTarget(
  mode: FilePanelMode,
  followCwd: string | null,
  currentPath: string | null
): string | null {
  if (mode === "follow") return null;
  return currentPath ?? followCwd ?? null;
}

/// 同一目录的两次列目录结果是否完全一样。自动刷新靠它决定要不要重画：
/// 内容没变就什么都不动，滚动位置与选中行不会被 3 秒一次的轮询打断。
export function sameListing(previous: FsListing | null, next: FsListing): boolean {
  if (!previous) return false;
  if (
    previous.path !== next.path ||
    previous.parent !== next.parent ||
    previous.total !== next.total ||
    previous.hidden_count !== next.hidden_count ||
    previous.truncated !== next.truncated ||
    previous.entries.length !== next.entries.length
  ) {
    return false;
  }
  for (let index = 0; index < next.entries.length; index += 1) {
    const a = previous.entries[index];
    const b = next.entries[index];
    if (
      a.name !== b.name ||
      a.kind !== b.kind ||
      a.link !== b.link ||
      a.size !== b.size ||
      a.modified_ms !== b.modified_ms ||
      a.hidden !== b.hidden
    ) {
      return false;
    }
  }
  return true;
}

/// 自动刷新的基础周期：普通目录 3 秒；条目多的目录放慢到 10 秒。
/// 读盘是每条目两次 stat、重绘是整表重建，几千项的目录按 3 秒轮询并不划算。
export const AUTO_REFRESH_MS = 3000;
export const AUTO_REFRESH_SLOW_MS = 10000;
/// 过滤前（含隐藏项）超过这个条目数就按「大目录」放慢。
export const AUTO_REFRESH_SLOW_TOTAL = 1000;

/// 下一次自动刷新等多久：大目录放慢；连续失败时指数退避（最多 24 秒），
/// 免得一个不可读的目录或断开的网络盘每 3 秒重试一次。
export function autoRefreshDelay(total: number, failures: number): number {
  const base = total > AUTO_REFRESH_SLOW_TOTAL ? AUTO_REFRESH_SLOW_MS : AUTO_REFRESH_MS;
  if (failures <= 0) return base;
  return Math.min(base * 2 ** Math.min(failures, 3), 24000);
}

/// 面板宽度的硬边界：太窄看不清名字，太宽会把终端挤到没法用。
export const MIN_PANEL_WIDTH = 140;
export const MAX_PANEL_WIDTH = 560;

/// 拖动分隔条时把宽度夹到合法区间。
/// 上限还要给终端留 `minMain` 像素，窗口很窄时宁可取最小值，由用户自己折叠面板。
export function clampPanelWidth(
  desired: number,
  viewport: number,
  sidebar = 196,
  minMain = 180
): number {
  const room = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewport - sidebar - minMain));
  return Math.max(MIN_PANEL_WIDTH, Math.min(room, Math.round(desired)));
}
