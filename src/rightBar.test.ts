import { describe, expect, it } from "vitest";
import {
  DEFAULT_RIGHT_BAR,
  clampPanelHeight,
  fillPanel,
  movePanel,
  parseRightBar,
  serializeRightBar,
  setPanelHidden,
  visiblePanels,
  type RightBarState
} from "./rightBar";

const allExpanded = { shortcuts: true, ports: true, files: true };

describe("parseRightBar", () => {
  it("缺省与坏数据回默认", () => {
    expect(parseRightBar(null)).toEqual(DEFAULT_RIGHT_BAR);
    expect(parseRightBar(42)).toEqual(DEFAULT_RIGHT_BAR);
    expect(parseRightBar("x")).toEqual(DEFAULT_RIGHT_BAR);
    expect(parseRightBar({})).toEqual(DEFAULT_RIGHT_BAR);
    expect(parseRightBar({ order: "nope", hidden: {} })).toEqual(DEFAULT_RIGHT_BAR);
  });

  it("认识的 id 按原顺序保留，缺的按默认顺序补在后面", () => {
    expect(parseRightBar({ order: ["files", "ports"] }).order).toEqual([
      "files",
      "ports",
      "shortcuts"
    ]);
  });

  it("丢弃重复与不认识的 id，hidden 只留认识的", () => {
    expect(
      parseRightBar({
        order: ["ports", "ports", "bogus", "shortcuts"],
        hidden: ["files", "files", "bogus"]
      })
    ).toEqual({ order: ["ports", "shortcuts", "files"], hidden: ["files"] });
  });
});

describe("serializeRightBar", () => {
  it("往返一致", () => {
    const state: RightBarState = { order: ["files", "shortcuts", "ports"], hidden: ["ports"] };
    expect(parseRightBar(JSON.parse(serializeRightBar(state)))).toEqual(state);
  });
});

describe("movePanel", () => {
  it("上下各换一格", () => {
    expect(movePanel(DEFAULT_RIGHT_BAR, "ports", -1).order).toEqual([
      "ports",
      "shortcuts",
      "files"
    ]);
    expect(movePanel(DEFAULT_RIGHT_BAR, "shortcuts", 1).order).toEqual([
      "ports",
      "shortcuts",
      "files"
    ]);
  });

  it("到头原样返回（同一个对象，调用方不必重画）", () => {
    expect(movePanel(DEFAULT_RIGHT_BAR, "shortcuts", -1)).toBe(DEFAULT_RIGHT_BAR);
    expect(movePanel(DEFAULT_RIGHT_BAR, "files", 1)).toBe(DEFAULT_RIGHT_BAR);
  });
});

describe("setPanelHidden", () => {
  it("勾掉不打乱顺序，勾回来原位", () => {
    const hidden = setPanelHidden(DEFAULT_RIGHT_BAR, "ports", true);
    expect(hidden.order).toEqual(["shortcuts", "ports", "files"]);
    expect(visiblePanels(hidden)).toEqual(["shortcuts", "files"]);
    expect(setPanelHidden(hidden, "ports", false)).toEqual(DEFAULT_RIGHT_BAR);
  });
});

describe("fillPanel", () => {
  it("最后一个可见且展开的面板吃剩余高度", () => {
    expect(fillPanel(DEFAULT_RIGHT_BAR, allExpanded)).toBe("files");
    expect(fillPanel(DEFAULT_RIGHT_BAR, { ...allExpanded, files: false })).toBe("ports");
    expect(fillPanel(DEFAULT_RIGHT_BAR, { shortcuts: true })).toBe("shortcuts");
  });

  it("跳过没勾选的面板", () => {
    const state = setPanelHidden(DEFAULT_RIGHT_BAR, "files", true);
    expect(fillPanel(state, allExpanded)).toBe("ports");
  });

  it("全折叠时没有人吃剩余高度", () => {
    expect(fillPanel(DEFAULT_RIGHT_BAR, {})).toBeNull();
  });

  it("顺序变了，吃剩余高度的也跟着变", () => {
    const state = movePanel(DEFAULT_RIGHT_BAR, "shortcuts", 1); // ports, shortcuts, files
    expect(fillPanel(state, allExpanded)).toBe("files");
    const filesFirst = movePanel(
      movePanel(movePanel(DEFAULT_RIGHT_BAR, "files", -1), "files", -1),
      "files",
      -1
    );
    expect(filesFirst.order).toEqual(["files", "shortcuts", "ports"]);
    expect(fillPanel(filesFirst, allExpanded)).toBe("ports");
  });
});

describe("clampPanelHeight", () => {
  it("下限 120，上限为可用高度的 70%", () => {
    expect(clampPanelHeight(10, 800)).toBe(120);
    expect(clampPanelHeight(560, 800)).toBe(560);
    expect(clampPanelHeight(900, 800)).toBe(560);
  });

  it("可用高度很小时先把上限抬到下限", () => {
    expect(clampPanelHeight(500, 100)).toBe(120);
  });

  it("取整并兜住 NaN", () => {
    expect(clampPanelHeight(180.6, 800)).toBe(181);
    expect(clampPanelHeight(Number.NaN, 800)).toBe(120);
  });
});
