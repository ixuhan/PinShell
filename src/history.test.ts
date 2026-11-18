// L0-07 / L0-09：Ghost Text 前缀匹配、检索过滤与跨天锚点。
// 纯函数、无 DOM、无 IPC；跑法与 Rust 的 L0 一样属于常跑集。

import { describe, expect, it } from "vitest";
import {
  filterHistory,
  ghostFor,
  isCaseSensitive,
  localDay,
  localTime,
  matches,
  withDayAnchors,
  type HistoryItem
} from "./history";

function item(id: number, command: string, used_ms = id): HistoryItem {
  return { id, command, used_ms, use_count: 1 };
}

/** 与缓存同序：`id` 升序（最旧在前），`ghostFor` 自己从尾巴往前扫。 */
function oldestFirst(items: HistoryItem[]): HistoryItem[] {
  return items.slice().sort((a, b) => a.id - b.id);
}

describe("Ghost Text 前缀匹配（L0-07）", () => {
  const history = oldestFirst([
    item(1, "git status"),
    item(2, "git stash"),
    item(3, "git commit -m 'wip'"),
    item(4, "ls -la"),
    item(5, "GIT PUSH")
  ]);

  it("只在行尾、单行、非空白时出现", () => {
    expect(ghostFor(history, "git s", true)).toBe("git stash");
    expect(ghostFor(history, "git s", false)).toBeNull();
    expect(ghostFor(history, "  ", true)).toBeNull();
    expect(ghostFor(history, "a\nb", true)).toBeNull();
    expect(ghostFor(history, "", true)).toBeNull();
  });

  it("大小写不敏感，且最近优先", () => {
    expect(ghostFor(history, "git S", true)).toBe("git stash");
    expect(ghostFor(history, "GIT", true)).toBe("GIT PUSH");
  });

  it("与输入完全相同不算建议，多行条目不参与", () => {
    expect(ghostFor(history, "git stash", true)).toBeNull();
    const withMultiline = oldestFirst([item(9, "echo one\necho two"), item(8, "echo hi")]);
    expect(ghostFor(withMultiline, "echo", true)).toBe("echo hi");
  });

  it("5000 条内 p99 < 1ms，同步计算", () => {
    const big: HistoryItem[] = Array.from({ length: 5000 }, (_, index) =>
      item(index + 1, `git commit -m "message ${index}"`, 1_700_000_000_000 + index)
    );
    const recent = oldestFirst(big);
    const queries = ["git ", "git c", "git co", "git com", "make", "npm", "docker", "ps", "git st"];
    // 预热，排除 JIT 首轮
    for (let i = 0; i < 100; i++) ghostFor(recent, queries[i % queries.length], true);

    // 样本取多一些：p99 落在第 990 个样本上，单次 GC 停顿不会把结论翻红
    const samples: number[] = [];
    for (let round = 0; round < 1000; round++) {
      const query = queries[round % queries.length];
      const start = performance.now();
      ghostFor(recent, query, true);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.min(samples.length - 1, Math.floor(0.99 * samples.length))];
    expect(p99).toBeLessThan(1);
  });
});

describe("检索过滤", () => {
  const items = [
    item(1, "git status", 300),
    item(2, "GIT PUSH", 100),
    item(3, "git log", 200),
    item(4, "ls", 400)
  ];

  it("小写查询不区分大小写", () => {
    const hits = filterHistory(items, "git");
    expect(hits.map((entry) => entry.id)).toEqual([1, 3, 2]);
  });

  it("查询含大写时区分大小写", () => {
    expect(isCaseSensitive("Git")).toBe(true);
    expect(isCaseSensitive("git")).toBe(false);
    expect(matches("git status", "Git")).toBe(false);
    expect(matches("GitHub", "Git")).toBe(true);
    const hits = filterHistory(items, "GIT");
    expect(hits.map((entry) => entry.command)).toEqual(["GIT PUSH"]);
  });

  it("空查询返回全部并按最后使用时间倒序", () => {
    expect(filterHistory(items, "").map((entry) => entry.id)).toEqual([4, 1, 3, 2]);
  });
});

describe("时间戳锚点（L0-09）", () => {
  const at = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

  it("跨天插一行、同日不插", () => {
    const rows = withDayAnchors([
      item(1, "newest", at(2026, 11, 17, 9, 0)),
      item(2, "late night", at(2026, 11, 16, 23, 50)),
      item(3, "morning", at(2026, 11, 16, 8, 0)),
      item(4, "yesterday", at(2026, 11, 15, 12, 0))
    ]);
    expect(rows.map((row) => row.anchor)).toEqual([
      "2026-11-17",
      "2026-11-16",
      null,
      "2026-11-15"
    ]);
  });

  it("按本地时区而不是 UTC 判断跨天", () => {
    // 本地 00:10 与 23:50 一定是两天；反过来 UTC 可能同日或跨日
    const rows = withDayAnchors([
      item(1, "after midnight", at(2026, 6, 2, 0, 10)),
      item(2, "before midnight", at(2026, 6, 1, 23, 50))
    ]);
    expect(rows[0].anchor).toBe("2026-06-02");
    expect(rows[1].anchor).toBe("2026-06-01");
    expect(localDay(at(2026, 6, 1, 23, 50))).toBe("2026-06-01");
  });

  it("跨月与跨年边界正确", () => {
    const rows = withDayAnchors([
      item(1, "new year", at(2027, 1, 1, 0, 30)),
      item(2, "old year", at(2026, 12, 31, 23, 30))
    ]);
    expect(rows.map((row) => row.anchor)).toEqual(["2027-01-01", "2026-12-31"]);
  });

  it("行里只显示本地时分", () => {
    expect(localTime(at(2026, 11, 17, 9, 5))).toBe("09:05");
    expect(localTime(at(2026, 11, 17, 23, 59))).toBe("23:59");
  });
});
