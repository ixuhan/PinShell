import { describe, expect, it } from "vitest";
import { invertIds, pruneIds, selectAllIds, toggleId } from "./selection";

describe("list selection", () => {
  it("toggles one id without mutating the original set", () => {
    const original = new Set(["a"]);
    expect([...toggleId(original, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleId(original, "a")]).toEqual([]);
    expect([...original]).toEqual(["a"]);
  });

  it("selects all and inverts only within the live list", () => {
    expect([...selectAllIds(["a", "b"])].sort()).toEqual(["a", "b"]);
    // 不在当前列表里的旧选中项不会因为反选又冒出来
    expect([...invertIds(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["b"]);
    expect([...invertIds(new Set(["a", "b"]), ["a", "b"])]).toEqual([]);
  });

  it("drops ids that disappeared from the list", () => {
    expect([...pruneIds(new Set(["a", "gone", "b"]), ["a", "b", "c"])].sort()).toEqual(["a", "b"]);
    expect([...pruneIds(new Set(["gone"]), [])]).toEqual([]);
  });
});
