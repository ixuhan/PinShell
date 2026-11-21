import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_CURSOR_BLINK,
  TERMINAL_FONT_FAMILY,
  TERMINAL_WEBGL,
  clampFontSize
} from "./displaySettings";

describe("terminal display constants", () => {
  it("keeps the font size range in sync with the backend", () => {
    // 与 core-domain 的 MIN_FONT_SIZE / MAX_FONT_SIZE / DEFAULT_FONT_SIZE 一致
    expect(MIN_FONT_SIZE).toBe(9);
    expect(MAX_FONT_SIZE).toBe(28);
    expect(DEFAULT_FONT_SIZE).toBe(13);
    expect(DEFAULT_FONT_SIZE).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    expect(DEFAULT_FONT_SIZE).toBeLessThanOrEqual(MAX_FONT_SIZE);
  });

  it("keeps the font stack non-empty and monospace-first", () => {
    expect(TERMINAL_FONT_FAMILY).toContain("monospace");
    expect(TERMINAL_CURSOR_BLINK).toBe(true);
    expect(TERMINAL_WEBGL).toBe(true);
  });
});

describe("clampFontSize", () => {
  it("passes through values inside the range", () => {
    expect(clampFontSize(9)).toBe(9);
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(28)).toBe(28);
  });

  it("clamps out-of-range values instead of rejecting them", () => {
    expect(clampFontSize(0)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(-5)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(99)).toBe(MAX_FONT_SIZE);
  });

  it("rounds fractional sizes and falls back on garbage", () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize("20")).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(null)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(undefined)).toBe(DEFAULT_FONT_SIZE);
  });
});
