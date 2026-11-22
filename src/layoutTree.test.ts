import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  clampRatio,
  contains,
  depth,
  depthOf,
  hitZone,
  leaf,
  neighborOf,
  paneList,
  paneRects,
  removePane,
  sideOf,
  splitPane,
  swapPanes,
  type PaneLayout
} from "./layoutTree";

function quad(): PaneLayout {
  return {
    kind: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: {
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: leaf("a"),
      second: leaf("b")
    },
    second: {
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: leaf("c"),
      second: leaf("d")
    }
  };
}

describe("splitPane", () => {
  it("places the new pane on the requested side and keeps the ratio on the first child", () => {
    for (const [side, axis, order] of [
      ["right", "horizontal", ["a", "b"]],
      ["left", "horizontal", ["b", "a"]],
      ["bottom", "vertical", ["a", "b"]],
      ["top", "vertical", ["b", "a"]]
    ] as const) {
      const split = splitPane(leaf("a"), "a", side, 0.3, "b");
      expect(split).not.toBeNull();
      expect(split!.kind).toBe("split");
      if (split!.kind !== "split") continue;
      expect(split!.axis).toBe(axis);
      expect(split!.ratio).toBeCloseTo(0.3);
      expect(paneList(split!)).toEqual([...order]);
    }
  });

  it("clamps the ratio instead of rejecting it", () => {
    const split = splitPane(leaf("a"), "a", "right", 5, "b");
    expect(split!.kind).toBe("split");
    if (split!.kind === "split") expect(split!.ratio).toBeCloseTo(0.9);
  });

  it("returns null for an unknown target or a fourth level", () => {
    expect(splitPane(leaf("a"), "ghost", "right", 0.5, "b")).toBeNull();

    let tree: PaneLayout = leaf("a");
    for (const [target, id] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"]
    ]) {
      const next = splitPane(tree, target, "right", 0.5, id);
      expect(next).not.toBeNull();
      tree = next!;
    }
    expect(depth(tree)).toBe(MAX_DEPTH);
    // 第 4 层：既不能静默截断，也不能返回一棵超深的树
    expect(splitPane(tree, "d", "right", 0.5, "e")).toBeNull();
  });
});

describe("tree edits", () => {
  it("removes a leaf, collapses its parent and reports an empty tree as null", () => {
    const tree = quad();
    const left = removePane(tree, "a")!;
    expect(paneList(left)).toEqual(["b", "c", "d"]);
    expect(depth(left)).toBe(2);

    expect(removePane(leaf("a"), "a")).toBeNull();
    // 不存在的会话原样返回
    expect(paneList(removePane(tree, "ghost")!)).toEqual(["a", "b", "c", "d"]);
  });

  it("swaps two panes without touching the shape", () => {
    const swapped = swapPanes(quad(), "a", "d");
    expect(paneList(swapped)).toEqual(["d", "b", "c", "a"]);
    expect(depth(swapped)).toBe(2);
    // 同一个 id 交换等于没换
    expect(paneList(swapPanes(quad(), "a", "a"))).toEqual(["a", "b", "c", "d"]);
  });

  it("answers containment, depth and the leaf list in reading order", () => {
    const tree = quad();
    expect(paneList(tree)).toEqual(["a", "b", "c", "d"]);
    expect(contains(tree, "c")).toBe(true);
    expect(contains(tree, "ghost")).toBe(false);
    expect(depthOf(tree, "a")).toBe(2);
    expect(depthOf(tree, "c")).toBe(2);
    expect(depthOf(tree, "ghost")).toBeNull();
  });
});

describe("geometry", () => {
  it("splits rectangles by the ratio of the first child", () => {
    const rects = paneRects({
      kind: "split",
      axis: "horizontal",
      ratio: 0.3,
      first: leaf("a"),
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: leaf("b"),
        second: leaf("c")
      }
    });
    expect(rects.get("a")).toMatchObject({ x: 0, y: 0, width: 0.3, height: 1 });
    expect(rects.get("b")).toMatchObject({ x: 0.3, y: 0, width: 0.7, height: 0.5 });
    expect(rects.get("c")).toMatchObject({ x: 0.3, y: 0.5, width: 0.7, height: 0.5 });
  });

  it("finds the nearest neighbour by direction in a 2x2 grid", () => {
    const tree = quad();
    expect(neighborOf(tree, "a", "right")).toBe("c");
    expect(neighborOf(tree, "a", "down")).toBe("b");
    expect(neighborOf(tree, "b", "right")).toBe("d");
    expect(neighborOf(tree, "d", "left")).toBe("b");
    expect(neighborOf(tree, "d", "up")).toBe("c");
    expect(neighborOf(tree, "c", "left")).toBe("a");
    // 边缘方向没有邻格
    expect(neighborOf(tree, "a", "left")).toBeNull();
    expect(neighborOf(tree, "a", "up")).toBeNull();
    expect(neighborOf(tree, "ghost", "right")).toBeNull();
  });

  it("maps pointer positions to edge hot zones with a stable centre", () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    expect(sideOf(rect, 10, 50)).toBe("left");
    expect(sideOf(rect, 90, 50)).toBe("right");
    expect(sideOf(rect, 50, 10)).toBe("top");
    expect(sideOf(rect, 50, 90)).toBe("bottom");
    expect(hitZone(rect, 50, 50)).toEqual({ kind: "center" });
    // 角上两边都够近：取归一化距离更小的那条，距离相等时优先左右
    expect(sideOf(rect, 5, 5)).toBe("left");
    // 退化矩形不产生误命中
    expect(hitZone({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toEqual({
      kind: "center"
    });
  });

  it("clamps ratios and turns non-finite values into the default", () => {
    expect(clampRatio(0)).toBeCloseTo(0.1);
    expect(clampRatio(1)).toBeCloseTo(0.9);
    expect(clampRatio(0.42)).toBeCloseTo(0.42);
    expect(clampRatio(Number.NaN)).toBeCloseTo(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBeCloseTo(0.5);
  });
});
