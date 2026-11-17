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

/** ASCII 小写折叠：只认 A-Z，其余原样返回。 */
function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/**
 * `command` 是否以 `needleLower` 为前缀（后者必须已是小写），且比它更长。
 *
 * 逐字符比较、遇到差异立刻退出：按键路径上每条命令各来一次 `toLowerCase()` 会在
 * 5000 条窗口里制造 5000 个短命字符串，GC 停顿会把 p99 推过 1ms。这里常见的
 * ASCII 路径零分配；只有前缀里出现非 ASCII（中文路径等）才退回切片比较。
 */
function startsWithLower(command: string, needleLower: string): boolean {
  if (command.length <= needleLower.length) return false;
  for (let i = 0; i < needleLower.length; i++) {
    const a = command.charCodeAt(i);
    const b = needleLower.charCodeAt(i);
    if (a === b) continue;
    if (a < 128 && b < 128) {
      if (foldAscii(a) !== b) return false;
      continue;
    }
    return command.slice(0, needleLower.length).toLowerCase() === needleLower;
  }
  return true;
}

/**
 * Ghost Text：输入非空白、单行且光标在行尾时，取最近一条以输入为前缀的命令。
 * `recent` 必须按「最新在前」传入；多行命令不参与建议；与输入完全相同不算建议。
 */
export function ghostFor(
  recent: HistoryItem[],
  input: string,
  atLineEnd: boolean
): string | null {
  if (!atLineEnd) return null;
  if (!input.trim()) return null;
  if (input.includes("\n") || input.includes("\r")) return null;
  const needle = input.toLowerCase();
  for (const item of recent) {
    const command = item.command;
    if (command.length <= input.length) continue; // 等长/更短都不可能是建议
    if (command === input) continue;
    if (command.includes("\n") || command.includes("\r")) continue;
    if (startsWithLower(command, needle)) return command;
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
