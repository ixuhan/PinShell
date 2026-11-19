import { describe, expect, it } from "vitest";
import { clearDisplayMode } from "./displayClear";

describe("清屏显示策略", () => {
  it("串口清屏必须 reset 当前活动行，避免保留断开前的最后一个字节", () => {
    expect(clearDisplayMode("serial")).toBe("reset");
  });

  it("终端清屏保留当前提示行", () => {
    expect(clearDisplayMode("terminal")).toBe("preserve-current-line");
  });
});
