// 查找（Find）的纯逻辑：偏好读写、命中序号换算、到头判定。
//
// 只放可以脱离 DOM 与 xterm 单测的东西；查找条本身、@xterm/addon-search 与
// 每分格的状态都在 `findBarUi.ts`。术语见 GLOSSARY「查找」。
//
// 注意：addon 没有「不循环」的开关，它的 `findNext` 到最后一个之后会自己绕回第一个。
// 所以循环查找是**我们这边**的闸门：先看 `canStep`，不许走就根本不调 addon。

export interface FindPrefs {
  /** 区分大小写。默认关：终端输出里大小写混排，先给宽的那一档。 */
  caseSensitive: boolean;
  /** 循环查找。默认开：最后一个命中的下一个回到第一个。 */
  wrap: boolean;
}

/// 与 `pinshell.locale`、`pinshell.rightbar` 同一层：界面偏好，不进 Rust 的工作区快照。
export const FIND_PREFS_KEY = "pinshell.find";

export const DEFAULT_FIND_PREFS: FindPrefs = { caseSensitive: false, wrap: true };

/// 宽容解析：没存过、存坏了、字段类型不对都退回默认值，不让一条坏记录挡住查找。
export function parseFindPrefs(raw: string | null): FindPrefs {
  if (!raw) return { ...DEFAULT_FIND_PREFS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_FIND_PREFS };
    const record = parsed as Record<string, unknown>;
    return {
      caseSensitive:
        typeof record.caseSensitive === "boolean"
          ? record.caseSensitive
          : DEFAULT_FIND_PREFS.caseSensitive,
      wrap: typeof record.wrap === "boolean" ? record.wrap : DEFAULT_FIND_PREFS.wrap
    };
  } catch {
    return { ...DEFAULT_FIND_PREFS };
  }
}

export function serializeFindPrefs(prefs: FindPrefs): string {
  return JSON.stringify({ caseSensitive: prefs.caseSensitive, wrap: prefs.wrap });
}

/// 空查询不搜：addon 拿到空串会清掉选区，界面却还会显示「0/0」，没必要走一趟。
export function hasQuery(text: string): boolean {
  return text.length > 0;
}

/// addon 报的是 0 起的结果下标与总数；界面要 1 起的「第几个」。没有当前命中时是 0。
/// 结果数被封顶（addon 的 `highlightLimit`）时，下标永远落在封顶后的范围里。
export function hitNumber(resultIndex: number, resultCount: number): number {
  if (resultCount <= 0 || resultIndex < 0) return 0;
  return Math.min(resultIndex + 1, resultCount);
}

/// `3/17`；没有结果时 `0/0`，有结果但当前没有命中（重算途中）时如实显示 `0/17`。
export function formatHit(number: number, total: number): string {
  const safeTotal = Math.max(0, total);
  if (safeTotal === 0) return "0/0";
  const safeNumber = Math.min(Math.max(number, 0), safeTotal);
  return `${safeNumber}/${safeTotal}`;
}

/// 能不能再往下（`delta > 0`）或往上走一步。
/// 循环开着永远能走——addon 自己会绕回；关掉后停在两端，界面给「到头了」而不是静默不动。
export function canStep(number: number, total: number, delta: 1 | -1, wrap: boolean): boolean {
  if (total <= 0) return false;
  if (wrap) return true;
  if (number <= 0) return true; // 还没有当前命中：先落到第一个/最后一个
  return delta > 0 ? number < total : number > 1;
}
