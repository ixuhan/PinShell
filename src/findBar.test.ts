// L0：查找的纯逻辑——偏好读写、命中序号换算、到头判定。
// 纯函数、无 DOM、无 xterm；跑法与其它前端单测一样属于常跑集。

import { describe, expect, it } from "vitest";
import { SearchAddon } from "@xterm/addon-search";
import {
  DEFAULT_FIND_PREFS,
  canStep,
  formatHit,
  hasQuery,
  hitNumber,
  parseFindPrefs,
  serializeFindPrefs
} from "./findBar";

describe("查找偏好", () => {
  it("没存过时给默认值：不区分大小写、循环开", () => {
    expect(parseFindPrefs(null)).toEqual({ caseSensitive: false, wrap: true });
    expect(DEFAULT_FIND_PREFS).toEqual({ caseSensitive: false, wrap: true });
  });

  it("存坏了退回默认值", () => {
    expect(parseFindPrefs("{")).toEqual(DEFAULT_FIND_PREFS);
    expect(parseFindPrefs("null")).toEqual(DEFAULT_FIND_PREFS);
    expect(parseFindPrefs("42")).toEqual(DEFAULT_FIND_PREFS);
    expect(parseFindPrefs("[]")).toEqual(DEFAULT_FIND_PREFS);
  });

  it("缺字段或类型不对的字段各自退回默认值", () => {
    expect(parseFindPrefs('{"caseSensitive":true}')).toEqual({ caseSensitive: true, wrap: true });
    expect(parseFindPrefs('{"wrap":false}')).toEqual({ caseSensitive: false, wrap: false });
    expect(parseFindPrefs('{"caseSensitive":"yes","wrap":0}')).toEqual(DEFAULT_FIND_PREFS);
  });

  it("写出再读回来是同一份", () => {
    const prefs = { caseSensitive: true, wrap: false };
    expect(parseFindPrefs(serializeFindPrefs(prefs))).toEqual(prefs);
    expect(parseFindPrefs(serializeFindPrefs(DEFAULT_FIND_PREFS))).toEqual(DEFAULT_FIND_PREFS);
  });
});

describe("空查询", () => {
  it("空串不搜，空格与制表符照搜（终端里空白也是内容）", () => {
    expect(hasQuery("")).toBe(false);
    expect(hasQuery(" ")).toBe(true);
    expect(hasQuery("\t")).toBe(true);
  });
});

describe("命中序号", () => {
  it("addon 的 0 起下标换成 1 起的第几个", () => {
    expect(hitNumber(0, 3)).toBe(1);
    expect(hitNumber(2, 3)).toBe(3);
  });

  it("没有当前命中、没有结果、下标越界都收敛到合法值", () => {
    expect(hitNumber(-1, 5)).toBe(0);
    expect(hitNumber(0, 0)).toBe(0);
    expect(hitNumber(9, 3)).toBe(3);
  });

  it("文案是 n/m，无命中时 0/0", () => {
    expect(formatHit(3, 17)).toBe("3/17");
    expect(formatHit(0, 0)).toBe("0/0");
    expect(formatHit(0, 5)).toBe("0/5");
    expect(formatHit(7, 5)).toBe("5/5");
  });
});

describe("到头判定（循环关掉时）", () => {
  const wrap = false;

  it("没有结果时哪边都不动", () => {
    expect(canStep(0, 0, 1, wrap)).toBe(false);
    expect(canStep(0, 0, -1, true)).toBe(false);
  });

  it("循环关掉后停在两端", () => {
    expect(canStep(3, 3, 1, wrap)).toBe(false); // 最后一个，再往下就是绕回
    expect(canStep(1, 3, -1, wrap)).toBe(false); // 第一个，再往上就是绕回
    expect(canStep(2, 3, 1, wrap)).toBe(true);
    expect(canStep(2, 3, -1, wrap)).toBe(true);
  });

  it("还没有当前命中时允许先落到第一个/最后一个", () => {
    expect(canStep(0, 3, 1, wrap)).toBe(true);
    expect(canStep(0, 3, -1, wrap)).toBe(true);
  });

  it("只有一个命中时循环开着能再走一步，关掉后两边都停", () => {
    expect(canStep(1, 1, 1, true)).toBe(true);
    expect(canStep(1, 1, -1, true)).toBe(true);
    expect(canStep(1, 1, 1, false)).toBe(false);
    expect(canStep(1, 1, -1, false)).toBe(false);
  });
});

describe("插件契约", () => {
  // 查找的匹配、高亮、计数全在第三方插件里。升级后成员改名或签名变了，
  // 这条会先红，不用等用户按 Ctrl+Shift+F 才发现。
  it("暴露我们依赖的四个成员", () => {
    const addon = new SearchAddon();
    expect(typeof addon.findNext).toBe("function");
    expect(typeof addon.findPrevious).toBe("function");
    expect(typeof addon.clearDecorations).toBe("function");
    expect(addon.onDidChangeResults).toBeTypeOf("function");
    addon.dispose();
  });
});
