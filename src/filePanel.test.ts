// M4 文件面板的纯逻辑：显示格式、路径拼接与「跟随 / 固定」的目标路径。
// 无 DOM、无 IPC，属于常跑集（L0）。

import { describe, expect, it } from "vitest";
import {
  formatSize,
  formatTime,
  joinPath,
  panelTarget,
  type FsEntry
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
