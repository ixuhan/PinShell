import { describe, expect, it } from "vitest";
import { keepAfter } from "./outQueue";

describe("清屏后的输出过滤（keepAfter）", () => {
  it("下限之前的块全部丢掉，之后的按原顺序拼起来", () => {
    const kept = keepAfter(
      [
        { seq: 1, data: "old1" },
        { seq: 2, data: "old2" },
        { seq: 3, data: "new1" },
        { seq: 4, data: "new2" }
      ],
      2
    );
    expect(kept.parts.join("")).toBe("new1new2");
    expect(kept.lastSeq).toBe(4);
  });

  it("全部早于下限时什么都不留，序号归零", () => {
    const kept = keepAfter(
      [
        { seq: 1, data: "a" },
        { seq: 2, data: "b" }
      ],
      2
    );
    expect(kept.parts).toEqual([]);
    expect(kept.lastSeq).toBe(0);
  });

  it("下限为 0（没清过屏）时一块都不丢", () => {
    const kept = keepAfter(
      [
        { seq: 1, data: "a" },
        { seq: 2, data: "b" }
      ],
      0
    );
    expect(kept.parts.join("")).toBe("ab");
    expect(kept.lastSeq).toBe(2);
  });

  it("块乱序到达也按到达顺序拼，序号取最大值", () => {
    const kept = keepAfter(
      [
        { seq: 5, data: "later" },
        { seq: 3, data: "earlier" }
      ],
      2
    );
    expect(kept.parts.join("")).toBe("laterearlier");
    expect(kept.lastSeq).toBe(5);
  });
});
