// 契约：只有焦点报告（ESC[I / ESC[O）被摘掉，其余字节一个不动。
// 这条边界决定「用户的按键」和「终端对 Shell 的应答」能不能原样到达 Shell。

import { describe, expect, it } from "vitest";
import { stripFocusReports } from "./ptyInput";

describe("写进 PTY 前的过滤（焦点报告）", () => {
  it("单独一串焦点报告整段摘掉", () => {
    expect(stripFocusReports("\x1b[I")).toBe("");
    expect(stripFocusReports("\x1b[O")).toBe("");
  });

  it("连着的多串一次全摘", () => {
    expect(stripFocusReports("\x1b[I\x1b[O\x1b[I\x1b[O")).toBe("");
  });

  it("夹在按键中间的只摘报告，按键留着", () => {
    expect(stripFocusReports("a\x1b[Ib")).toBe("ab");
    expect(stripFocusReports("\x1b[Iecho ok\x1b[O")).toBe("echo ok");
  });

  it("光标位置应答是应答，必须原样转给 Shell", () => {
    expect(stripFocusReports("\x1b[12;1R")).toBe("\x1b[12;1R");
    expect(stripFocusReports("\x1b[I\x1b[3;5R")).toBe("\x1b[3;5R");
  });

  it("普通输入（含中文与控制字符）不受影响", () => {
    expect(stripFocusReports("")).toBe("");
    expect(stripFocusReports("git status")).toBe("git status");
    expect(stripFocusReports("看看目录")).toBe("看看目录");
    // Ctrl+C / Tab / 退格这类控制字节也在同一条通道上
    expect(stripFocusReports("\x03\t\x7f")).toBe("\x03\t\x7f");
  });

  it("长得像但不是焦点的 CSI 序列不动", () => {
    expect(stripFocusReports("\x1b[A")).toBe("\x1b[A"); // 方向键上
    expect(stripFocusReports("\x1b[1;2I")).toBe("\x1b[1;2I"); // 带参数，不是焦点报告
  });
});
