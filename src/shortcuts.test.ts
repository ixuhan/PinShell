import { describe, expect, it } from "vitest";
import { clampShortcutHeight, moveShortcut, parseShortcutExport, type Shortcut } from "./shortcuts";

const item = (id: string): Shortcut => ({ id, name: id, command: id, mode: "fill" });

describe("shortcut data", () => {
  it("validates JSON imports atomically and accepts duplicate names", () => {
    const parsed = parseShortcutExport(JSON.stringify([item("a"), { ...item("b"), name: "a" }]));
    expect(parsed.map((entry) => entry.name)).toEqual(["a", "a"]);
    expect(() => parseShortcutExport('[{"name":"bad"}]')).toThrow("格式无效");
  });

  it("reorders items without moving outside the list", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(moveShortcut(items, 1, -1).map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(moveShortcut(items, 0, -1)).toBe(items);
  });

  it("keeps file list room and clamps the height", () => {
    expect(clampShortcutHeight(500, 600)).toBe(300);
    expect(clampShortcutHeight(500, 400)).toBe(200);
    expect(clampShortcutHeight(10, 500)).toBe(120);
  });
});
