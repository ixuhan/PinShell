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

  it("caps the height at 70% like the left panel, and keeps a 120px floor", () => {
    expect(clampShortcutHeight(500, 600)).toBe(420);
    expect(clampShortcutHeight(500, 400)).toBe(280);
    expect(clampShortcutHeight(10, 500)).toBe(120);
    // 另一栏可以被压到 30%：与左栏「串口拖到 70%」的表现一致
    expect(clampShortcutHeight(9999, 1000)).toBe(700);
  });
});
