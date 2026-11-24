// @vitest-environment happy-dom
// 第三方插件的真实行为：折行、大小写、循环。
//
// 这一层必须有一个 DOM：xterm 不 `open()` 就没有 selection service，插件内部的
// `select()` 会直接抛 TypeError。`scripts/bench-scrollback.mjs` 那种纯 Node 跑法
// 只能验证「解析 + 缓冲」。happy-dom 足够让 `open()` 走通，于是折行与命中计数
// 可以在这里钉住，而不用等手工验收。
//
// 这是**第三方行为**的看门狗：插件升级后若折行处理或绕回语义变了，这里先红。

import { describe, expect, it } from "vitest";
import { Terminal, type IBufferLine } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";

const colors = {
  matchBackground: "#1c3a2d",
  matchBorder: "#46d19a",
  matchOverviewRuler: "#46d19a",
  activeMatchBackground: "#24674f",
  activeMatchBorder: "#46d19a",
  activeMatchColorOverviewRuler: "#46d19a"
};

interface Harness {
  term: Terminal;
  search: SearchAddon;
  /// 每次结果变化记一笔，最后一条就是当前状态。
  events: { resultIndex: number; resultCount: number }[];
  write: (text: string) => Promise<void>;
}

async function makeTerminal(cols = 40, rows = 8): Promise<Harness> {
  const term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  const search = new SearchAddon();
  term.loadAddon(search);
  const events: { resultIndex: number; resultCount: number }[] = [];
  search.onDidChangeResults((event) => events.push(event));
  const write = (text: string) =>
    new Promise<void>((resolve) => term.write(text, () => resolve()));
  return { term, search, events, write };
}

function last(events: { resultIndex: number; resultCount: number }[]) {
  return events[events.length - 1];
}

/// 一行逻辑行在缓冲区里占了几个视觉行（xterm 用 `isWrapped` 标记续行）。
function wrappedRows(term: Terminal, text: string): number {
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y += 1) {
    const line: IBufferLine | undefined = buffer.getLine(y);
    if (line && line.translateToString(true).includes(text)) {
      let rows = 1;
      while (buffer.getLine(y + rows)?.isWrapped) rows += 1;
      return rows;
    }
  }
  return 0;
}

describe("大小写", () => {
  const CONTENT = "alpha one\r\nBETA alpha two\r\nALPHA three\r\n";

  it("默认不区分大小写：三种写法都算命中", async () => {
    const { search, events, write } = await makeTerminal();
    await write(CONTENT);
    search.findNext("alpha", { caseSensitive: false, decorations: colors });
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 3 });
  });

  it("打开区分大小写：只剩两处小写", async () => {
    const { search, events, write } = await makeTerminal();
    await write(CONTENT);
    search.findNext("alpha", { caseSensitive: true, decorations: colors });
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 2 });
  });

  it("查询本身的大小写也要紧：ALPHA 只命中那一处", async () => {
    const { search, events, write } = await makeTerminal();
    await write(CONTENT);
    search.findNext("ALPHA", { caseSensitive: true, decorations: colors });
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 1 });
  });
});

describe("循环", () => {
  it("插件的 findNext 到最后一个会绕回第一个（所以循环开关必须在我们这边拦）", async () => {
    const { search, events, write } = await makeTerminal();
    await write("alpha\r\nalpha\r\nalpha\r\n");
    const options = { caseSensitive: false, decorations: colors };
    search.findNext("alpha", options);
    search.findNext("alpha", options);
    search.findNext("alpha", options);
    expect(last(events)).toEqual({ resultIndex: 2, resultCount: 3 });
    search.findNext("alpha", options); // 再下一个：绕回
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 3 });
    search.findPrevious("alpha", options); // 反向也绕
    expect(last(events)).toEqual({ resultIndex: 2, resultCount: 3 });
  });
});

describe("折行", () => {
  // 10 列：这一行会被折成两个视觉行，"89ab" 横跨折点
  const LONG = "0123456789abcdefghij";

  it("一条超宽的行确实被折成多个视觉行", async () => {
    const { term, write } = await makeTerminal(10, 8);
    await write(`${LONG}\r\n`);
    expect(wrappedRows(term, "0123456789")).toBe(2);
  });

  it("跨折点的子串仍能命中（匹配的是逻辑行，不是视觉行）", async () => {
    const { term, search, events, write } = await makeTerminal(10, 8);
    await write(`${LONG}\r\n`);
    const found = search.findNext("89ab", { caseSensitive: false, decorations: colors });
    expect(found).toBe(true);
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 1 });
    // 命中之后插件会把这段文本选中，作为「当前命中」的落点
    expect(term.getSelection()).toBe("89ab");
  });

  it("跨折点的命中不会被算成两个", async () => {
    const { search, events, write } = await makeTerminal(10, 8);
    await write(`${LONG}\r\n${LONG}\r\n`);
    search.findNext("89ab", { caseSensitive: false, decorations: colors });
    expect(last(events)).toEqual({ resultIndex: 0, resultCount: 2 });
  });
});
