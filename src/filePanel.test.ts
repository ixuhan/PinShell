// M4 文件面板的纯逻辑：显示格式、路径拼接与「跟随 / 固定」的目标路径。
// 无 DOM、无 IPC，属于常跑集（L0）。

import { describe, expect, it } from "vitest";
import {
  AUTO_REFRESH_MS,
  AUTO_REFRESH_SLOW_MS,
  AUTO_REFRESH_SLOW_TOTAL,
  autoRefreshDelay,
  clampMenuPosition,
  clampPanelWidth,
  formatSize,
  formatTime,
  joinPath,
  normalizePanelPrefs,
  normalizePanelStore,
  panelTarget,
  parentPath,
  rowMenu,
  sameListing,
  type FsEntry,
  type FsListing
} from "./filePanel";

function entry(overrides: Partial<FsEntry>): FsEntry {
  return {
    name: "x",
    kind: "file",
    link: false,
    size: 0,
    modified_ms: null,
    hidden: false,
    ...overrides
  };
}

function listing(overrides: Partial<FsListing> = {}): FsListing {
  return {
    path: "C:\\work",
    parent: "C:\\",
    total: 1,
    hidden_count: 0,
    truncated: false,
    entries: [entry({ name: "a.txt", size: 3, modified_ms: 1000 })],
    ...overrides
  };
}

describe("formatSize", () => {
  it("目录与其它类型不显示大小", () => {
    expect(formatSize(entry({ kind: "dir", size: 4096 }))).toBe("");
    expect(formatSize(entry({ kind: "other", size: 4096 }))).toBe("");
  });

  it("按 B / KB / MB / GB 分档，10 以下留一位小数", () => {
    expect(formatSize(entry({ size: 0 }))).toBe("0 B");
    expect(formatSize(entry({ size: 1023 }))).toBe("1023 B");
    expect(formatSize(entry({ size: 1024 }))).toBe("1.0 KB");
    expect(formatSize(entry({ size: 1536 }))).toBe("1.5 KB");
    expect(formatSize(entry({ size: 20 * 1024 }))).toBe("20 KB");
    expect(formatSize(entry({ size: 1024 * 1024 }))).toBe("1.0 MB");
    expect(formatSize(entry({ size: 3.5 * 1024 * 1024 }))).toBe("3.5 MB");
    expect(formatSize(entry({ size: 2 * 1024 * 1024 * 1024 }))).toBe("2.0 GB");
  });
});

describe("formatTime", () => {
  const now = new Date(2026, 10, 17, 20, 0).getTime();

  it("当天只显示时分", () => {
    expect(formatTime(new Date(2026, 10, 17, 18, 5).getTime(), now)).toBe("18:05");
  });

  it("同年跨天显示月日与时分", () => {
    expect(formatTime(new Date(2026, 10, 16, 9, 3).getTime(), now)).toBe("11-16 09:03");
  });

  it("跨年只显示日期", () => {
    expect(formatTime(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe("2025-12-31");
  });

  it("没有时间就显示空串", () => {
    expect(formatTime(null, now)).toBe("");
    expect(formatTime(Number.NaN, now)).toBe("");
  });
});

describe("joinPath", () => {
  it("根后面不会多出第二个分隔符", () => {
    expect(joinPath("C:\\", "work")).toBe("C:\\work");
    expect(joinPath("C:\\work\\", "src")).toBe("C:\\work\\src");
  });

  it("正斜杠与重复分隔符都按 Windows 显示", () => {
    expect(joinPath("C:/work//", "a.txt")).toBe("C:\\work\\a.txt");
  });

  it("空父路径直接用名字", () => {
    expect(joinPath("", "C:\\work")).toBe("C:\\work");
  });
});

describe("parentPath", () => {
  it("盘符根没有上一级", () => {
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("C:\\work")).toBe("C:\\");
    expect(parentPath("C:\\work\\src\\")).toBe("C:\\work");
  });

  it("UNC 共享根没有上一级，共享内的目录照常上翻", () => {
    expect(parentPath("\\\\server\\share")).toBeNull();
    expect(parentPath("\\\\server\\share\\dir")).toBe("\\\\server\\share");
    expect(parentPath("\\\\server\\share\\dir\\deep")).toBe("\\\\server\\share\\dir");
  });

  it("相对路径与空路径不给上一级", () => {
    expect(parentPath("work\\src")).toBe("work");
    expect(parentPath("work")).toBeNull();
    expect(parentPath("")).toBeNull();
  });

  it("读不出来的中文路径也能算出上一级（权限拒绝对话框的退出路径）", () => {
    expect(parentPath("C:\\Users\\96485\\『开始』菜单\\程序")).toBe("C:\\Users\\96485\\『开始』菜单");
  });

  it("正斜杠与重复分隔符先归一化再上翻", () => {
    expect(parentPath("C:/work//src/")).toBe("C:\\work");
  });
});

describe("panelTarget", () => {
  it("跟随模式交给后端按会话 CWD 解析", () => {
    expect(panelTarget("follow", "C:\\work", "C:\\elsewhere")).toBeNull();
  });

  it("固定模式优先用当前停留的路径", () => {
    expect(panelTarget("fixed", "C:\\work", "C:\\pinned")).toBe("C:\\pinned");
  });

  it("固定模式还没导航过就用一次 CWD 起步", () => {
    expect(panelTarget("fixed", "C:\\work", null)).toBe("C:\\work");
  });

  it("什么都没有时返回空，交给后端回退主目录", () => {
    expect(panelTarget("fixed", null, null)).toBeNull();
  });
});

describe("clampPanelWidth", () => {
  it("上限内原样保留", () => {
    expect(clampPanelWidth(300, 1600)).toBe(300);
  });

  it("太窄时取最小宽度", () => {
    expect(clampPanelWidth(40, 1600)).toBe(140);
  });

  it("太宽时先撞 560 的硬上限", () => {
    expect(clampPanelWidth(900, 1600)).toBe(560);
  });

  it("窗口变窄时上限跟着收缩，给终端留 180px", () => {
    expect(clampPanelWidth(500, 800)).toBe(424);
  });

  it("极窄窗口仍保住最小宽度，由用户折叠面板", () => {
    expect(clampPanelWidth(500, 480)).toBe(140);
  });
});

describe("sameListing", () => {
  it("两次结果完全一样就是 true", () => {
    expect(sameListing(listing(), listing())).toBe(true);
  });

  it("没有上一次结果时一律算变化", () => {
    expect(sameListing(null, listing())).toBe(false);
  });

  it("条目名、大小、时间、类型、链接、隐藏任一不同都算变化", () => {
    const base = listing();
    const variants: Partial<FsEntry>[] = [
      { name: "b.txt" },
      { size: 4 },
      { modified_ms: 2000 },
      { kind: "dir" },
      { link: true },
      { hidden: true }
    ];
    for (const variant of variants) {
      const next = listing({ entries: [entry({ name: "a.txt", size: 3, modified_ms: 1000, ...variant })] });
      expect(sameListing(base, next)).toBe(false);
    }
  });

  it("条目顺序变了也算变化", () => {
    const a = listing({
      total: 2,
      entries: [entry({ name: "a" }), entry({ name: "b" })]
    });
    const b = listing({
      total: 2,
      entries: [entry({ name: "b" }), entry({ name: "a" })]
    });
    expect(sameListing(a, b)).toBe(false);
  });

  it("路径、总数、隐藏数、截断标记变化都算变化", () => {
    const base = listing();
    expect(sameListing(base, listing({ path: "C:\\other" }))).toBe(false);
    expect(sameListing(base, listing({ parent: null }))).toBe(false);
    expect(sameListing(base, listing({ total: 2 }))).toBe(false);
    expect(sameListing(base, listing({ hidden_count: 1 }))).toBe(false);
    expect(sameListing(base, listing({ truncated: true }))).toBe(false);
    expect(sameListing(base, listing({ entries: [] }))).toBe(false);
  });
});

describe("autoRefreshDelay", () => {
  it("普通目录 3 秒，大目录放慢到 10 秒", () => {
    expect(autoRefreshDelay(20, 0)).toBe(AUTO_REFRESH_MS);
    expect(autoRefreshDelay(AUTO_REFRESH_SLOW_TOTAL, 0)).toBe(AUTO_REFRESH_MS);
    expect(autoRefreshDelay(AUTO_REFRESH_SLOW_TOTAL + 1, 0)).toBe(AUTO_REFRESH_SLOW_MS);
  });

  it("连续失败按 2 的幂退避，最多 24 秒", () => {
    expect(autoRefreshDelay(20, 1)).toBe(6000);
    expect(autoRefreshDelay(20, 2)).toBe(12000);
    expect(autoRefreshDelay(20, 3)).toBe(24000);
    expect(autoRefreshDelay(20, 9)).toBe(24000);
    expect(autoRefreshDelay(5000, 2)).toBe(24000);
  });
});

describe("降级右键菜单", () => {
  it("文件有四项：打开、定位、复制、填入输入条", () => {
    const items = rowMenu("file");
    expect(items.map((item) => item.command)).toEqual(["open", "reveal", "copy", "fill"]);
    expect(items[0].label).toBe("用默认程序打开");
  });

  it("目录只有三项，且「打开」就是进入该目录", () => {
    const items = rowMenu("dir");
    expect(items.map((item) => item.command)).toEqual(["open", "reveal", "copy"]);
    expect(items[0].label).toBe("打开");
  });

  it("「..」行没有填入输入条，标签点明是上级目录", () => {
    const items = rowMenu("parent");
    expect(items.map((item) => item.command)).toEqual(["open", "reveal", "copy"]);
    expect(items[1].label).toBe("在资源管理器中显示上级目录");
  });

  it("未知类型按文件处理，仍可定位与复制", () => {
    expect(rowMenu("other").map((item) => item.command)).toEqual([
      "open",
      "reveal",
      "copy",
      "fill"
    ]);
  });
});

describe("菜单定位", () => {
  it("空间够就落在右键处，整数像素", () => {
    expect(clampMenuPosition(120.4, 80.6, 180, 140, 1280, 820)).toEqual({ x: 120, y: 81 });
  });

  it("贴右边界时往左翻，不越出视口", () => {
    const spot = clampMenuPosition(1270, 100, 180, 140, 1280, 820);
    expect(spot.x).toBe(1280 - 180 - 6);
  });

  it("贴下边界时往上翻", () => {
    const spot = clampMenuPosition(100, 815, 180, 140, 1280, 820);
    expect(spot.y).toBe(820 - 140 - 6);
  });

  it("窗口比菜单还小时仍留出边距，不出现负坐标", () => {
    expect(clampMenuPosition(-20, -30, 180, 140, 120, 100)).toEqual({ x: 6, y: 6 });
  });
});

describe("文件面板设置按会话存储", () => {
  it("旧版顶层的全局设置迁移成默认值，已有会话仍按它显示", () => {
    const store = normalizePanelStore({ expanded: false, width: 240, mode: "fixed", auto: true, showHidden: true });
    expect(store.expanded).toBe(false);
    expect(store.width).toBe(240);
    expect(store.defaults).toEqual({ mode: "fixed", auto: true, showHidden: true, path: null });
    expect(store.sessions).toEqual({});
  });

  it("每个会话各存一套：跟随/自动/隐藏互不影响", () => {
    const store = normalizePanelStore({
      sessions: {
        a: { mode: "follow", auto: true, showHidden: false, path: "C:\\ignored" },
        b: { mode: "fixed", auto: false, showHidden: true, path: "C:\\work" }
      }
    });
    expect(store.sessions.a).toEqual({ mode: "follow", auto: true, showHidden: false, path: null });
    expect(store.sessions.b).toEqual({ mode: "fixed", auto: false, showHidden: true, path: "C:\\work" });
  });

  it("跟随模式不保留固定路径，切回固定时从 CWD 重新起步", () => {
    expect(normalizePanelPrefs({ mode: "follow", path: "C:\\work" }).path).toBeNull();
    expect(normalizePanelPrefs({ mode: "fixed", path: "C:\\work" }).path).toBe("C:\\work");
  });

  it("脏数据逐字段退回 fallback，坏掉一个不影响其它", () => {
    const prefs = normalizePanelPrefs(
      { mode: "wat", auto: "yes", showHidden: 1, path: 42 },
      { mode: "fixed", auto: true, showHidden: true, path: "C:\\base" }
    );
    expect(prefs).toEqual({ mode: "fixed", auto: true, showHidden: true, path: null });
  });

  it("宽度只接受正数，坏值退回按窗口比例", () => {
    expect(normalizePanelStore({ width: 320 }).width).toBe(320);
    expect(normalizePanelStore({ width: -5 }).width).toBe(0);
    expect(normalizePanelStore({ width: Number.NaN }).width).toBe(0);
    expect(normalizePanelStore({ width: "320" }).width).toBe(0);
  });

  it("完全空的存储是「跟随 + 不自动 + 不显示隐藏项」", () => {
    const store = normalizePanelStore(null);
    expect(store.expanded).toBe(true);
    expect(store.defaults).toEqual({ mode: "follow", auto: false, showHidden: false, path: null });
  });
});
