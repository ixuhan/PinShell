// 项目栏的宽度与整栏折叠：夹取、存储解析、序列化。无 DOM，属于常跑集（L0）。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  parseStored,
  serializePrefs
} from "./sidebar";

describe("clampSidebarWidth", () => {
  it("合法区间内原样保留", () => {
    expect(clampSidebarWidth(240, 1600, 272)).toBe(240);
  });

  it("太窄时取最小宽度", () => {
    expect(clampSidebarWidth(40, 1600, 272)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("太宽时先撞 360 的硬上限", () => {
    expect(clampSidebarWidth(900, 1600, 0)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("给功能栏和终端留位置：窗口不够宽时上限跟着收缩", () => {
    // 700 - 300（功能栏）- 180（终端）= 220
    expect(clampSidebarWidth(300, 700, 300)).toBe(220);
  });

  it("极窄窗口仍保住最小宽度，由用户自己去缩别的栏", () => {
    expect(clampSidebarWidth(300, 500, 300)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("功能栏收起（只剩 26px）时能拖得更宽", () => {
    expect(clampSidebarWidth(300, 700, 26)).toBe(300);
  });

  it("拖动给的是小数时四舍五入，避免半像素抖动", () => {
    expect(clampSidebarWidth(233.4, 1600, 272)).toBe(233);
    expect(clampSidebarWidth(233.6, 1600, 272)).toBe(234);
  });
});

describe("parseStored", () => {
  it("没有记录就用默认宽度、不收起", () => {
    expect(parseStored(null)).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
    expect(parseStored("")).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
  });

  it("更早版本存的纯数字仍然认，按展开处理", () => {
    expect(parseStored("240")).toEqual({ width: 240, collapsed: false });
    expect(parseStored("240.6")).toEqual({ width: 241, collapsed: false });
  });

  it("读回宽度与折叠状态", () => {
    expect(parseStored('{"width":240,"collapsed":true}')).toEqual({ width: 240, collapsed: true });
    expect(parseStored('{"width":301}')).toEqual({ width: 301, collapsed: false });
  });

  it("只存了折叠状态时宽度回默认值", () => {
    expect(parseStored('{"collapsed":true}')).toEqual({
      width: DEFAULT_SIDEBAR_WIDTH,
      collapsed: true
    });
  });

  it("坏数据一律回到默认值，不会让项目栏张不开", () => {
    expect(parseStored("abc")).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
    expect(parseStored("-20")).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
    expect(parseStored("0")).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
    expect(parseStored("NaN")).toEqual({ width: DEFAULT_SIDEBAR_WIDTH, collapsed: false });
    expect(parseStored('{"width":-5,"collapsed":true}')).toEqual({
      width: DEFAULT_SIDEBAR_WIDTH,
      collapsed: true
    });
    expect(parseStored('{"width":"abc"}')).toEqual({
      width: DEFAULT_SIDEBAR_WIDTH,
      collapsed: false
    });
  });
});

describe("serializePrefs", () => {
  it("宽度与折叠状态能原样读回来", () => {
    expect(parseStored(serializePrefs({ width: 233, collapsed: true }))).toEqual({
      width: 233,
      collapsed: true
    });
  });

  it("写出来的是 JSON，不再是一个裸数字", () => {
    expect(serializePrefs({ width: 196, collapsed: false })).toBe(
      '{"width":196,"collapsed":false}'
    );
  });
});
