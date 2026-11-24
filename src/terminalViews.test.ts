import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 视图池的契约测试。跑在 node 里，不引入 jsdom：xterm 与 DOM 节点都只用到很少的
 * 接口，用最小桩就能守住「不重复 open」「WebGL 按可见数分配」「销毁幂等」三条命门。
 */

const counts = vi.hoisted(() => ({ webglCreated: 0, webglDisposed: 0 }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    openCount = 0;
    disposed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
    loadAddon() {}
    open() {
      this.openCount += 1;
    }
    onData() {}
    onBell() {}
    focus() {}
    dispose() {
      this.disposed = true;
    }
    refresh() {}
    reset() {}
    write() {}
    scrollToBottom() {}
    clear() {}
  }
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  }
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    disposed = false;
    constructor() {
      counts.webglCreated += 1;
    }
    onContextLoss() {}
    dispose() {
      this.disposed = true;
      counts.webglDisposed += 1;
    }
  }
}));

interface FakeElement {
  className: string;
  dataset: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  listeners: Map<string, Array<() => void>>;
  append(child: FakeElement): void;
  remove(): void;
  contains(target: unknown): boolean;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

function fakeElement(): FakeElement {
  const el: FakeElement = {
    className: "",
    dataset: {},
    children: [],
    parentElement: null,
    listeners: new Map<string, Array<() => void>>(),
    append(child) {
      // 真 DOM 的 append 会先把节点从旧父节点上摘下来，假节点必须照做，
      // 否则「搬 hostEl」这件事在测试里会看起来像多复制了一份。
      const previous = child.parentElement;
      if (previous) {
        previous.children = previous.children.filter((item) => item !== child);
      }
      child.parentElement = el;
      el.children.push(child);
    },
    remove() {
      const parent = el.parentElement;
      if (parent) parent.children = parent.children.filter((item) => item !== el);
      el.parentElement = null;
    },
    contains(target) {
      return target === el;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    fire(type) {
      for (const fn of el.listeners.get(type) ?? []) fn();
    }
  };
  return el;
}

beforeEach(() => {
  counts.webglCreated = 0;
  counts.webglDisposed = 0;
  vi.stubGlobal("document", { createElement: () => fakeElement() });
});

async function loadPool() {
  const { TerminalPool } = await import("./terminalViews");
  return new TerminalPool({
    fontFamily: "mono",
    fontSize: 13,
    lineHeight: 1.4,
    cursorBlink: false,
    scrollback: 100,
    theme: () => ({}),
    webglEnabled: true,
    onData: () => {}
  });
}

function container(): FakeElement {
  return fakeElement();
}

describe("TerminalPool", () => {
  it("creates one terminal per session and never calls open twice", async () => {
    const pool = await loadPool();
    const first = container();
    const view = pool.attach("a", first as unknown as HTMLElement, true);
    expect((view.term as unknown as { openCount: number }).openCount).toBe(1);

    const again = pool.attach("a", first as unknown as HTMLElement, true);
    expect(again).toBe(view);
    expect((again.term as unknown as { openCount: number }).openCount).toBe(1);
    expect(first.children).toHaveLength(1);
  });

  it("moves the persistent host element instead of rebuilding the terminal", async () => {
    const pool = await loadPool();
    const first = container();
    const second = container();
    const view = pool.attach("a", first as unknown as HTMLElement, true);
    pool.attach("a", second as unknown as HTMLElement, true);

    expect(pool.view("a")).toBe(view);
    expect((view.term as unknown as { openCount: number }).openCount).toBe(1);
    expect(first.children).toHaveLength(0);
    expect(second.children).toHaveLength(1);
    expect(view.hostEl.parentElement).toBe(second);
  });

  it("allocates WebGL only for visible panes and reuses freed slots", async () => {
    const pool = await loadPool();
    const ids = Array.from({ length: 9 }, (_, i) => `s${i}`);
    for (const id of ids) {
      pool.attach(id, container() as unknown as HTMLElement, true);
    }
    // 预算 8：第 9 个可见格留在 DOM 渲染器
    expect(counts.webglCreated).toBe(8);
    expect(pool.view("s8")!.webgl).toBeNull();

    // 隐藏一个释放上下文，再显示第 9 个才有位置
    pool.setVisible("s0", false);
    expect(counts.webglDisposed).toBe(1);
    pool.setVisible("s8", true);
    expect(counts.webglCreated).toBe(9);
    expect(pool.view("s8")!.webgl).not.toBeNull();
  });

  it("disposes the renderer, the addon and the map entry, and is idempotent", async () => {
    const pool = await loadPool();
    const view = pool.attach("a", container() as unknown as HTMLElement, true);
    pool.attach("b", container() as unknown as HTMLElement, true);

    pool.dispose("a");
    expect((view.term as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(pool.view("a")).toBeNull();
    expect(counts.webglDisposed).toBe(1);

    // 再销毁一次不能抛，也不能误伤别的视图
    expect(() => pool.dispose("a")).not.toThrow();
    expect(pool.view("b")).not.toBeNull();
    expect(pool.all()).toHaveLength(1);

    pool.disposeAll();
    expect(pool.all()).toHaveLength(0);
    expect(counts.webglDisposed).toBe(2);
  });

  it("reports focusin from the view so the app can switch session context", async () => {
    const { TerminalPool } = await import("./terminalViews");
    const focused: string[] = [];
    const pool = new TerminalPool({
      fontFamily: "mono",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      scrollback: 100,
      theme: () => ({}),
      webglEnabled: false,
      onData: () => {},
      onFocus: (id) => focused.push(id)
    });
    const a = pool.attach("a", container() as unknown as HTMLElement, true);
    const b = pool.attach("b", container() as unknown as HTMLElement, true);

    // 点击 B 的终端主体：DOM 焦点落在 B 的宿主节点上，应用层据此切上下文
    (b.hostEl as unknown as FakeElement).fire("focusin");
    expect(focused).toEqual(["b"]);

    // 程序化把焦点搬回 A 也走同一条上报；去重由应用层的 focusSessionId 判断负责
    (a.hostEl as unknown as FakeElement).fire("focusin");
    expect(focused).toEqual(["b", "a"]);
  });

  it("does not mount WebGL when the global switch is off", async () => {
    const { TerminalPool } = await import("./terminalViews");
    const pool = new TerminalPool({
      fontFamily: "mono",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      scrollback: 100,
      theme: () => ({}),
      webglEnabled: false,
      onData: () => {}
    });
    const view = pool.attach("a", container() as unknown as HTMLElement, true);
    expect(view.webgl).toBeNull();
    expect(counts.webglCreated).toBe(0);
  });

  it("turns LF into a real line break only for serial views", async () => {
    // 串口设备常只发裸 `\n`：不开启 convertEol 时 xterm 只下移一行、列不动，
    // 屏幕上每一行都从上一行结尾接着写（像没换行），日志文件却是正常分行。
    const pool = await loadPool();
    const serial = pool.attach("serial", container() as unknown as HTMLElement, true, true);
    const terminal = pool.attach("term", container() as unknown as HTMLElement, true);
    expect(serial.convertEol).toBe(true);
    expect((serial.term as unknown as { options: Record<string, unknown> }).options.convertEol).toBe(true);
    expect(terminal.convertEol).toBe(false);
    expect((terminal.term as unknown as { options: Record<string, unknown> }).options.convertEol).toBe(false);

    // 复用同一个视图时按新参数改，不重建终端
    const again = pool.attach("serial", container() as unknown as HTMLElement, true, false);
    expect(again).toBe(serial);
    expect(again.convertEol).toBe(false);
    expect((again.term as unknown as { options: Record<string, unknown> }).options.convertEol).toBe(false);
    expect((again.term as unknown as { openCount: number }).openCount).toBe(1);
  });
});
