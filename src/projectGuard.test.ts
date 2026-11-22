import { describe, expect, it } from "vitest";
import { isProjectOpenCurrent } from "./projectGuard";

describe("isProjectOpenCurrent", () => {
  it("accepts only the same token and the same active project", () => {
    expect(isProjectOpenCurrent(3, 3, "p1", "p1")).toBe(true);
    // 代次过期：用户在拉起途中又切了一次
    expect(isProjectOpenCurrent(2, 3, "p1", "p1")).toBe(false);
    // 已经切到别的项目
    expect(isProjectOpenCurrent(3, 3, "p2", "p1")).toBe(false);
    // 清空选中项目（项目被删掉）
    expect(isProjectOpenCurrent(3, 3, null, "p1")).toBe(false);
  });
});
