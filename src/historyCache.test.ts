// L2-02：历史缓存契约。
// 纯逻辑（快照带 upto、追加 id 单调、跳号整份重建、切会话丢弃缓存），
// 与 Rust 侧的 history_snapshot / history:append 形状一一对应。

import { describe, expect, it } from "vitest";
import { applyAppend, emptyCache, fromSnapshot, type HistoryCache } from "./historyCache";
import { HISTORY_WINDOW, type HistoryItem } from "./history";

function item(id: number, command: string, used_ms = id, use_count = 1): HistoryItem {
  return { id, command, used_ms, use_count };
}

function snapshotOf(session: string, upto: number, items: HistoryItem[]) {
  return { session_id: session, upto_id: upto, items };
}

function appendOf(session: string, entry: HistoryItem) {
  return { session_id: session, item: entry };
}

describe("历史缓存契约（L2-02）", () => {
  it("快照带 upto_id，条目按 id 升序，只留最近 5000 条", () => {
    const many: HistoryItem[] = Array.from({ length: HISTORY_WINDOW + 5 }, (_, index) =>
      item(index + 1, `cmd ${index}`)
    );
    const cache = fromSnapshot(snapshotOf("s1", many.length, many.slice().reverse()));
    expect(cache.session).toBe("s1");
    expect(cache.upto).toBe(HISTORY_WINDOW + 5);
    expect(cache.items.length).toBe(HISTORY_WINDOW);
    // 丢的是最旧的 5 条，顺序仍是升序（最后一条最新）
    expect(cache.items[0].id).toBe(6);
    expect(cache.items.at(-1)?.id).toBe(HISTORY_WINDOW + 5);
  });

  it("id 正好 +1 才追加，切到最新并累加次数由事件自带", () => {
    const cache = fromSnapshot(snapshotOf("s1", 2, [item(1, "ls"), item(2, "git status")]));
    const outcome = applyAppend(cache, "s1", appendOf("s1", item(3, "make", 30, 1)));
    expect(outcome.kind).toBe("append");
    if (outcome.kind !== "append") return;
    expect(outcome.cache.upto).toBe(3);
    expect(outcome.cache.items.map((entry) => entry.command)).toEqual(["ls", "git status", "make"]);
  });

  it("同一条命令再次提交：摘掉旧行、挪到最新", () => {
    const cache = fromSnapshot(snapshotOf("s1", 2, [item(1, "ls"), item(2, "make")]));
    const outcome = applyAppend(cache, "s1", appendOf("s1", item(3, "ls", 30, 2)));
    expect(outcome.kind).toBe("append");
    if (outcome.kind !== "append") return;
    expect(outcome.cache.items.map((entry) => entry.command)).toEqual(["make", "ls"]);
    expect(outcome.cache.items.at(-1)?.use_count).toBe(2);
  });

  it("跳号即整份重建，不逐条修补", () => {
    const cache = fromSnapshot(snapshotOf("s1", 2, [item(1, "ls"), item(2, "make")]));
    expect(applyAppend(cache, "s1", appendOf("s1", item(9, "late"))).kind).toBe("rebuild");
  });

  it("重复投递（id <= upto）被丢掉", () => {
    const cache = fromSnapshot(snapshotOf("s1", 5, [item(5, "make")]));
    expect(applyAppend(cache, "s1", appendOf("s1", item(5, "make"))).kind).toBe("ignore");
    expect(applyAppend(cache, "s1", appendOf("s1", item(4, "older"))).kind).toBe("ignore");
  });

  it("不是当前会话的事件一律不认（切走后的迟到事件）", () => {
    const cache = fromSnapshot(snapshotOf("s2", 1, [item(1, "ls")]));
    expect(applyAppend(cache, "s2", appendOf("s1", item(2, "other"))).kind).toBe("ignore");
    expect(applyAppend(cache, "s2", appendOf("s3", item(2, "other"))).kind).toBe("ignore");
  });

  it("切会话先丢弃整份缓存：旧条目清空、旧号不继承", () => {
    const old = fromSnapshot(snapshotOf("s1", 7, [item(6, "a"), item(7, "b")]));
    expect(old.items.length).toBe(2);

    const fresh = emptyCache("s2");
    expect(fresh.items).toEqual([]);
    expect(fresh.upto).toBe(0);

    // 新会话的旧号（比如 42）不算 +1，触发一次重建
    expect(applyAppend(fresh, "s2", appendOf("s2", item(42, "x"))).kind).toBe("rebuild");
    // 旧会话的事件此时应该被忽略，不会污染新会话的缓存
    expect(applyAppend(fresh, "s2", appendOf("s1", item(8, "b"))).kind).toBe("ignore");
  });

  it("空会话的第一次提交（id 从 1 开始）直接接上缓存", () => {
    const cache: HistoryCache = emptyCache("s1");
    const outcome = applyAppend(cache, "s1", appendOf("s1", item(1, "first")));
    expect(outcome.kind).toBe("append");
    if (outcome.kind !== "append") return;
    expect(outcome.cache.upto).toBe(1);
    expect(outcome.cache.items.map((entry) => entry.command)).toEqual(["first"]);
  });

  it("追加也会把超过 5000 条的旧条目挤掉", () => {
    const full: HistoryItem[] = Array.from({ length: HISTORY_WINDOW }, (_, index) =>
      item(index + 1, `cmd ${index}`)
    );
    const cache = fromSnapshot(snapshotOf("s1", HISTORY_WINDOW, full));
    const outcome = applyAppend(
      cache,
      "s1",
      appendOf("s1", item(HISTORY_WINDOW + 1, "newest"))
    );
    expect(outcome.kind).toBe("append");
    if (outcome.kind !== "append") return;
    expect(outcome.cache.items.length).toBe(HISTORY_WINDOW);
    expect(outcome.cache.items[0].id).toBe(2);
    expect(outcome.cache.items.at(-1)?.command).toBe("newest");
  });
});
