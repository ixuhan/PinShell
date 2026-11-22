import { describe, expect, it } from "vitest";
import { decideDrop, exceededDragThreshold } from "./paneDrag";

describe("decideDrop", () => {
  it("swaps on the centre and splits on an edge", () => {
    expect(decideDrop({ kind: "center" }, "a", "b")).toEqual({ action: "swap" });
    expect(decideDrop({ kind: "edge", side: "left" }, "a", "b")).toEqual({
      action: "split",
      side: "left"
    });
    expect(decideDrop({ kind: "edge", side: "bottom" }, "a", "b")).toEqual({
      action: "split",
      side: "bottom"
    });
  });

  it("bounces for a pane dropped on itself or outside any pane", () => {
    expect(decideDrop({ kind: "center" }, "a", "a")).toEqual({ action: "none" });
    expect(decideDrop({ kind: "edge", side: "right" }, "a", "a")).toEqual({ action: "none" });
    expect(decideDrop({ kind: "center" }, "a", "")).toEqual({ action: "none" });
    expect(decideDrop({ kind: "center" }, "a", null)).toEqual({ action: "none" });
    expect(decideDrop({ kind: "center" }, null, "b")).toEqual({ action: "none" });
  });
});

describe("exceededDragThreshold", () => {
  it("treats small movement as a click and larger movement as a drag", () => {
    expect(exceededDragThreshold(10, 10, 12, 11)).toBe(false);
    expect(exceededDragThreshold(10, 10, 10, 10)).toBe(false);
    expect(exceededDragThreshold(10, 10, 20, 10)).toBe(true);
    expect(exceededDragThreshold(0, 0, 3, 4)).toBe(true);
    // 阈值可覆盖，便于将来按 DPI 调整
    expect(exceededDragThreshold(0, 0, 3, 4, 10)).toBe(false);
  });
});
