// @vitest-environment happy-dom
// 查找条的交互状态机：打开/关闭、每分格独立、去抖、循环闸门、0 命中文案。
//
// 这里用的是**桩插件**：匹配算法属于 `@xterm/addon-search`，它在没有 `open()` 的
// xterm 里跑不起来（见 docs/find.md 的测试一节）。这个文件只钉我们自己的那层：
// 什么时候调插件、传什么选项、怎么把结果画出来、焦点还给谁。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "./terminalViews";
import { setupFindBar, type FindBarHandle } from "./findBarUi";

interface Stub {
  view: TerminalView;
  findNext: ReturnType<typeof vi.fn>;
  findPrevious: ReturnType<typeof vi.fn>;
  clearDecorations: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
}

/// 桩插件：行为照真插件的关键语义——同一个查询换位置、换查询回到第一个、
/// `clearDecorations` 把缓存一并清掉（所以下一次 `findNext` 从顶部重来）。
function stubView(id: string, hits: (query: string) => number): Stub {
  const hostEl = document.createElement("div");
  document.body.append(hostEl);

  let total = 0;
  let index = -1;
  let lastQuery = "";
  let notify: ((event: { resultIndex: number; resultCount: number }) => void) | null = null;

  const emit = () => notify?.({ resultIndex: index, resultCount: total });

  const findNext = vi.fn((query: string) => {
    if (lastQuery !== query) {
      total = hits(query);
      index = -1;
      lastQuery = query;
    }
    index = total === 0 ? -1 : (index + 1) % total;
    emit();
    return total > 0;
  });

  const findPrevious = vi.fn((query: string) => {
    if (lastQuery !== query) {
      total = hits(query);
      index = total;
      lastQuery = query;
    }
    index = total === 0 ? -1 : (index - 1 + total) % total;
    emit();
    return total > 0;
  });

  const clearDecorations = vi.fn(() => {
    total = 0;
    index = -1;
    lastQuery = "";
  });

  const clearSelection = vi.fn();

  const search = {
    findNext,
    findPrevious,
    clearDecorations,
    onDidChangeResults: (cb: (event: { resultIndex: number; resultCount: number }) => void) => {
      notify = cb;
      return { dispose: () => { notify = null; } };
    }
  };

  const view = { id, hostEl, term: { clearSelection }, search } as unknown as TerminalView;
  return { view, findNext, findPrevious, clearDecorations, clearSelection };
}

interface Harness {
  handle: FindBarHandle;
  focus: { id: string };
  restoreFocus: ReturnType<typeof vi.fn>;
  changed: ReturnType<typeof vi.fn>;
}

function setup(stubs: Stub[], activeId = stubs[0]?.view.id ?? ""): Harness {
  const byId = new Map(stubs.map((stub) => [stub.view.id, stub.view]));
  const focus = { id: activeId };
  const restoreFocus = vi.fn();
  const changed = vi.fn();
  const handle = setupFindBar({
    view: (id) => byId.get(id) ?? null,
    activeId: () => focus.id,
    restoreFocus,
    changed
  });
  return { handle, focus, restoreFocus, changed };
}

function bar(id: string): HTMLElement | null {
  const host = document.querySelector<HTMLElement>(`div[data-stub="${id}"]`);
  return host?.querySelector<HTMLElement>(".find-bar") ?? null;
}

/// 桩视图的宿主节点打上标记，方便按会话找它的查找条。
function mark(stub: Stub): void {
  stub.view.hostEl.dataset.stub = stub.view.id;
}

function inputOf(id: string): HTMLInputElement {
  return bar(id)!.querySelector<HTMLInputElement>(".find-input")!;
}

function countOf(id: string): string {
  return bar(id)!.querySelector<HTMLElement>(".find-count")!.textContent ?? "";
}

function type(id: string, text: string): void {
  const input = inputOf(id);
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

/// 去抖 50ms：等一小会儿，让它真的跑到插件那一层。
const settle = () => new Promise((resolve) => setTimeout(resolve, 90));

function press(id: string, key: string, shiftKey = false): void {
  inputOf(id).dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  document.body.textContent = "";
});

describe("入口与焦点", () => {
  it("冷格没有 Terminal：Ctrl+Shift+F 什么都不做", () => {
    const { handle } = setup([]);
    handle.toggle();
    expect(document.querySelector(".find-bar")).toBeNull();
    expect(handle.holdsKeys()).toBe(false);
  });

  it("打开后查找条可见、输入框拿焦点、按键归查找条", () => {
    const stub = stubView("a", () => 0);
    mark(stub);
    const { handle, changed } = setup([stub]);
    handle.toggle();
    expect(bar("a")!.hidden).toBe(false);
    expect(document.activeElement).toBe(inputOf("a"));
    expect(handle.holdsKeys()).toBe(true);
    expect(changed).toHaveBeenCalled();
    // 再按一次关掉
    handle.toggle();
    expect(bar("a")!.hidden).toBe(true);
    expect(handle.holdsKeys()).toBe(false);
  });

  it("Esc 关闭、清掉高亮、把焦点还回去", () => {
    const stub = stubView("a", () => 2);
    mark(stub);
    const { handle, restoreFocus } = setup([stub]);
    handle.toggle();
    type("a", "hit");
    press("a", "Escape");
    expect(bar("a")!.hidden).toBe(true);
    expect(stub.clearDecorations).toHaveBeenCalled();
    expect(stub.clearSelection).toHaveBeenCalled();
    expect(restoreFocus).toHaveBeenCalledWith("a");
  });
});

describe("查询与计数", () => {
  it("输入去抖之后才查，默认不区分大小写并带上装饰配色", async () => {
    const stub = stubView("a", () => 3);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "err");
    expect(stub.findNext).not.toHaveBeenCalled(); // 还在去抖窗口里
    await settle();
    expect(stub.findNext).toHaveBeenCalledTimes(1);
    const options = stub.findNext.mock.calls[0][1];
    expect(options.caseSensitive).toBe(false);
    expect(options.decorations.matchBackground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(countOf("a")).toBe("1/3");
  });

  it("清空查询就把高亮收掉，不调插件", async () => {
    const stub = stubView("a", () => 3);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "err");
    await settle();
    type("a", "");
    await settle();
    expect(stub.findNext).toHaveBeenCalledTimes(1); // 只有第一次
    expect(stub.clearDecorations).toHaveBeenCalled();
    expect(countOf("a")).toBe("0/0");
  });

  it("0 命中时输入框描红、计数是 0/0", async () => {
    const stub = stubView("a", () => 0);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "nope");
    await settle();
    expect(bar("a")!.classList.contains("nomatch")).toBe(true);
    expect(countOf("a")).toBe("0/0");
  });
});

describe("命中之间走动", () => {
  it("Enter 下一个、Shift+Enter 上一个", async () => {
    const stub = stubView("a", () => 3);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "x");
    await settle();
    expect(countOf("a")).toBe("1/3");
    press("a", "Enter");
    expect(countOf("a")).toBe("2/3");
    press("a", "Enter", true);
    expect(countOf("a")).toBe("1/3");
  });

  it("循环关掉后停在最后一个，不再调插件，并给出「已经到头了」", async () => {
    const stub = stubView("a", () => 2);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "x");
    await settle();
    // 默认循环开着：从 2/2 再往前会绕回 1/2
    press("a", "Enter");
    expect(countOf("a")).toBe("2/2");
    press("a", "Enter");
    expect(countOf("a")).toBe("1/2");

    // 关掉循环：2/2 再按一次就停住
    bar("a")!.querySelector<HTMLButtonElement>(".find-wrap")!.click();
    press("a", "Enter");
    expect(countOf("a")).toBe("2/2");
    const calls = stub.findNext.mock.calls.length;
    press("a", "Enter");
    expect(stub.findNext.mock.calls.length).toBe(calls);
    expect(countOf("a")).toBe("已经到头了");
  });

  it("大小写开关会落盘，并让插件整屏重来", async () => {
    const stub = stubView("a", () => 2);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "x");
    await settle();
    press("a", "Enter");
    bar("a")!.querySelector<HTMLButtonElement>(".find-case")!.click();
    expect(JSON.parse(localStorage.getItem("pinshell.find") ?? "{}")).toMatchObject({
      caseSensitive: true
    });
    expect(stub.clearDecorations).toHaveBeenCalled();
    const last = stub.findNext.mock.calls.at(-1)!;
    expect(last[1].caseSensitive).toBe(true);
    expect(countOf("a")).toBe("1/2"); // 从第一个重新开始
  });
});

describe("分格隔离", () => {
  it("切走隐藏、切回还原，两格的查询互不影响", async () => {
    const a = stubView("a", () => 1);
    const b = stubView("b", () => 2);
    mark(a);
    mark(b);
    const { handle, focus } = setup([a, b], "a");

    handle.toggle();
    type("a", "alpha");
    await settle();

    focus.id = "b";
    handle.setActive("b");
    expect(bar("a")!.hidden).toBe(true); // 走开的格子藏起来
    expect(inputOf("a").value).toBe("alpha"); // 但查询还在

    handle.toggle(); // 在 b 里打开
    expect(bar("b")!.hidden).toBe(false);
    expect(bar("a")!.hidden).toBe(true);
    expect(inputOf("a").value).toBe("alpha");

    focus.id = "a";
    handle.setActive("a");
    expect(bar("a")!.hidden).toBe(false);
    expect(inputOf("a").value).toBe("alpha");
    expect(bar("b")!.hidden).toBe(true);
  });

  it("清屏（closeFor）连查询一起关掉", async () => {
    const stub = stubView("a", () => 2);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "x");
    await settle();
    handle.closeFor("a");
    expect(bar("a")!.hidden).toBe(true);
    expect(inputOf("a").value).toBe("");
    expect(stub.clearDecorations).toHaveBeenCalled();
  });

  it("视图没了（forget）就把状态丢掉，不会带回旧查询", async () => {
    const stub = stubView("a", () => 2);
    mark(stub);
    const { handle } = setup([stub]);
    handle.toggle();
    type("a", "x");
    await settle();
    handle.forget("a");
    expect(bar("a")).toBeNull();
    expect(handle.holdsKeys()).toBe(false);
  });
});
