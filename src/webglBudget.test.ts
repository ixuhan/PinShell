import { describe, expect, it } from "vitest";
import { MAX_WEBGL_CONTEXTS, hasWebglRoom } from "./webglBudget";

describe("hasWebglRoom", () => {
  it("allows contexts up to the budget and refuses beyond it", () => {
    expect(hasWebglRoom(0)).toBe(true);
    expect(hasWebglRoom(MAX_WEBGL_CONTEXTS - 1)).toBe(true);
    expect(hasWebglRoom(MAX_WEBGL_CONTEXTS)).toBe(false);
    expect(hasWebglRoom(MAX_WEBGL_CONTEXTS + 1)).toBe(false);
  });

  it("accepts an explicit budget for tests and future tuning", () => {
    expect(hasWebglRoom(1, 2)).toBe(true);
    expect(hasWebglRoom(2, 2)).toBe(false);
  });
});
