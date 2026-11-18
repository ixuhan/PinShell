// 输入条历史的纯逻辑：Ghost Text 前缀匹配、Ctrl+R 本地过滤、跨天锚点。
//
// 这些规则必须在按键路径上同步完成（不走 IPC），所以放在前端；权威数据仍在核心：
// 这里的 `items` 只是附着时拿到的只读热缓存（最近 5000 条），写入、去重、全量检索
// 都在 `history.db`。规则与 `core-domain/src/history.rs` 保持一致：
// - 查询里出现大写字母 → 区分大小写；否则不区分；
// - Ctrl+R 结果按最后使用时间倒序；
// - 跨天按当前本地时区判断。

export interface HistoryItem {
  /** 会话内单调序号（第几次提交） */
  id: number;
  command: string;
  /** UTC 毫秒 */
  used_ms: number;
  use_count: number;
}

/** 前端热缓存与 ↑↓ 导航的窗口大小。 */
export const HISTORY_WINDOW = 5000;

/** 查询含大写字母才区分大小写。 */
export function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}

/** 子串匹配。空查询匹配一切。 */
export function matches(command: string, query: string): boolean {
  if (!query) return true;
  if (isCaseSensitive(query)) return command.includes(query);
  return command.toLowerCase().includes(query.toLowerCase());
}

/**
 * Ghost Text 的预计算视图：`commands[i]` / `lowers[i]` 对应 `items[i]`，多行命令在
 * 构图时就被剔掉（它们永远不参与建议）。
 *
 * 按数组身份缓存：缓存数组一变（切会话、追加一条）就整体重算一次，按键路径上因此
 * 只剩「长度比较 + startsWith」，不分配、不扫换行符。5000 条重建约零点几毫秒，
 * 且只发生在缓存替换的那一次调用上，不在连续按键里。
 */
interface GhostIndex {
  commands: string[];
  lowers: string[];
}

const ghostIndexes = new WeakMap<readonly HistoryItem[], GhostIndex>();

function ghostIndex(items: readonly HistoryItem[]): GhostIndex {
  const cached = ghostIndexes.get(items);
  if (cached) return cached;
  const commands: string[] = [];
  const lowers: string[] = [];
  for (const item of items) {
    const command = item.command;
    if (command.includes("\n") || command.includes("\r")) continue;
    commands.push(command);
    lowers.push(command.toLowerCase());
  }
  const index: GhostIndex = { commands, lowers };
  ghostIndexes.set(items, index);
  return index;
}

/**
 * Ghost Text：输入非空白、单行且光标在行尾时，取最近一条以输入为前缀的命令。
 *
 * `items` 按缓存顺序传入（`id` 升序，最旧在前），内部从尾巴往前扫，第一条命中的
 * 就是最近用过的。调用方不要为了「最新在前」再复制一遍数组。多行命令不参与建议；
 * 与输入等长（含完全相同）不算建议。
 */
export function ghostFor(
  items: readonly HistoryItem[],
  input: string,
  atLineEnd: boolean
): string | null {
  if (!atLineEnd) return null;
  if (!input.trim()) return null;
  if (input.includes("\n") || input.includes("\r")) return null;
  const needle = input.toLowerCase();
  const { commands, lowers } = ghostIndex(items);
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].length <= input.length) continue;
    if (lowers[i].startsWith(needle)) return commands[i];
  }
  return null;
}

/** Ctrl+R 的本地过滤：命中 + 按最后使用时间倒序（同时刻按 id 倒序）。 */
export function filterHistory(items: HistoryItem[], query: string): HistoryItem[] {
  return items
    .filter((item) => matches(item.command, query))
    .sort((a, b) => b.used_ms - a.used_ms || b.id - a.id);
}

const pad = (value: number) => (value < 10 ? `0${value}` : String(value));

/** UTC 毫秒 → 当前本地时区下的日期 `YYYY-MM-DD`（锚点与跨天判断都用它）。 */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** UTC 毫秒 → 本地 `HH:MM`。日期由锚点行提供，行里只显示时分。 */
export function localTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface HistoryRow {
  item: HistoryItem;
  /** 本地日期变化时给这一天的标签，与上一条同日为 `null` */
  anchor: string | null;
}

/**
 * 给按时间倒序的检索结果插日期锚点：第一条永远带标签，之后只在本地日期变化时带。
 * 跨天按当前本地时区判断（`Date` 默认就是本地时区）。
 */
export function withDayAnchors(items: HistoryItem[]): HistoryRow[] {
  let previous: string | null = null;
  return items.map((item) => {
    const day = localDay(item.used_ms);
    const anchor = day === previous ? null : day;
    previous = day;
    return { item, anchor };
  });
}
