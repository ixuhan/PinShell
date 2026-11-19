import { describe, expect, it } from "vitest";
import { normalizeHexInput } from "./hexInput";

describe("normalizeHexInput", () => {
  it("filters non-hex characters and groups digits into bytes", () => {
    expect(normalizeHexInput("48 65,6c-6c6fxyz")).toBe("48 65 6C 6C 6F");
  });

  it("keeps an unfinished byte at the end", () => {
    expect(normalizeHexInput("a1b2c")).toBe("A1 B2 C");
  });

  it("returns an empty string when there are no hex digits", () => {
    expect(normalizeHexInput("xyz")).toBe("");
  });
});
