// 子栏折叠的纯逻辑：状态解析、箭头与提示文案（L0，无 DOM）。

import { describe, expect, it } from "vitest";
import { foldChevron, foldTitle, parseFolded, serializeFolded } from "./panelFold";

describe("子栏折叠状态存取", () => {
  it("只认 1 和 0，往返一致", () => {
    expect(parseFolded(serializeFolded(true))).toBe(true);
    expect(parseFolded(serializeFolded(false))).toBe(false);
  });

  it("没有记录或数据被写坏时按默认展开，内容看得见比藏起来安全", () => {
    expect(parseFolded(null)).toBe(false);
    expect(parseFolded("")).toBe(false);
    expect(parseFolded("true")).toBe(false);
    expect(parseFolded("2")).toBe(false);
    expect(parseFolded("bad")).toBe(false);
  });

  it("调用方可以要求默认收起", () => {
    expect(parseFolded(null, true)).toBe(true);
    expect(parseFolded("bad", true)).toBe(true);
    // 明确记录过就以记录为准
    expect(parseFolded("0", true)).toBe(false);
  });
});

describe("子栏折叠的箭头与提示", () => {
  it("收起指右、展开指下", () => {
    expect(foldChevron(true)).toBe("▸");
    expect(foldChevron(false)).toBe("▾");
  });

  it("提示说清楚点下去会发生什么", () => {
    // 默认语言是中文：提示文案随 i18n 词典走
    expect(foldTitle("串口", true)).toBe("展开串口");
    expect(foldTitle("串口", false)).toBe("收起串口");
  });
});
