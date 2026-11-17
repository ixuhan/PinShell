// 历史缓存契约（L2-02）：附着时取一份带 `upto_id` 的快照，之后只吃 `history:append`。
//
// 规则（前端唯一允许持有的业务副本，见 docs/architecture.md §6「性能豁免」）：
// - `id` 是会话内单调提交号，一次只加一；收到 `<= upto` 的事件视为重复，丢掉；
// - 收到跳号就整份重建，不逐条修补（修补会把「丢了一条」变成「错了一条」）；
// - 缓存只留当前焦点会话：切会话先丢掉整份，再取新会话的快照；
// - 去重键是命令原文，与核心一致：同一条命令再次提交时挪到最新、次数取新事件的。
//
// 这里只做纯计算，不碰 IPC、不碰 DOM，因此能在常跑集里被 vitest 直接驱动。

import { HISTORY_WINDOW, type HistoryItem } from "./history";

export interface HistorySnapshot {
  session_id: string;
  upto_id: number;
  items: HistoryItem[];
}

export interface HistoryCache {
  /** 缓存属于哪个会话；空串表示还没为任何会话建过缓存 */
  session: string;
  /** 已经收到的最大提交号（快照的 `upto_id` 或最后一次追加的 `id`） */
  upto: number;
  /** 按 `id` 升序，最后一条最新；最多 `HISTORY_WINDOW` 条 */
  items: HistoryItem[];
}

export type AppendOutcome =
  | { kind: "ignore" }
  | { kind: "rebuild" }
  | { kind: "append"; cache: HistoryCache };

/** 切会话时的起点：丢掉旧会话的全部内容，号也从零重新对齐快照。 */
export function emptyCache(session: string): HistoryCache {
  return { session, upto: 0, items: [] };
}

/** 快照 → 缓存：按 id 升序，只留最近 `HISTORY_WINDOW` 条（更早的只在 Ctrl+R 全量检索里出现）。 */
export function fromSnapshot(snapshot: HistorySnapshot): HistoryCache {
  const items = snapshot.items.slice().sort((a, b) => a.id - b.id);
  return {
    session: snapshot.session_id,
    upto: snapshot.upto_id,
    items: items.slice(-HISTORY_WINDOW)
  };
}

/**
 * 处理一条 `history:append`：
 * - 不是当前会话 → `ignore`（切走后的迟到事件一律不认）；
 * - 缓存还没为该会话建好（附着中 / 刚重置）→ `rebuild`；
 * - 号没前进 → `ignore`（重复投递）；
 * - 跳号 → `rebuild`（整份重建）；
 * - 正好 +1 → `append`，返回新缓存（同命令先摘掉旧行）。
 */
export function applyAppend(
  cache: HistoryCache,
  currentSession: string,
  payload: { session_id: string; item: HistoryItem }
): AppendOutcome {
  if (!currentSession || payload.session_id !== currentSession) {
    return { kind: "ignore" };
  }
  if (payload.session_id !== cache.session) {
    return { kind: "rebuild" };
  }
  const item = payload.item;
  if (item.id <= cache.upto) {
    return { kind: "ignore" };
  }
  if (item.id !== cache.upto + 1) {
    return { kind: "rebuild" };
  }

  const items = cache.items.filter((entry) => entry.command !== item.command);
  items.push(item);
  if (items.length > HISTORY_WINDOW) {
    items.splice(0, items.length - HISTORY_WINDOW);
  }
  return { kind: "append", cache: { session: cache.session, upto: item.id, items } };
}
