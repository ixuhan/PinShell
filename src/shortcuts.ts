export type ShortcutMode = "execute" | "fill";

export interface Shortcut {
  id: string;
  name: string;
  command: string;
  mode: ShortcutMode;
}

export interface SessionShortcutPrefs {
  height: number;
  collapsed: boolean;
  items: Shortcut[];
}

export const DEFAULT_SHORTCUT_HEIGHT = 220;
export const MIN_SHORTCUT_HEIGHT = 120;
export const MIN_FILE_LIST_HEIGHT = 160;

export function clampShortcutHeight(value: number, available: number): number {
  const fileRoom = Math.max(0, available - MIN_FILE_LIST_HEIGHT);
  const max = Math.min(Math.floor(available * 0.5), fileRoom);
  const min = Math.min(MIN_SHORTCUT_HEIGHT, max);
  return Math.max(min, Math.min(Math.round(value), max));
}

export function normalizeShortcut(value: unknown): Shortcut | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Shortcut>;
  if (
    typeof item.name !== "string" ||
    typeof item.command !== "string" ||
    (item.mode !== "execute" && item.mode !== "fill")
  ) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
    name: item.name,
    command: item.command,
    mode: item.mode
  };
}

export function parseShortcutExport(text: string): Shortcut[] {
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!items) throw new Error("指令集格式无效：需要 JSON 数组或包含 items 数组的对象");
  const normalized = items.map(normalizeShortcut);
  if (normalized.some((item) => item === null)) {
    throw new Error("指令集格式无效：每项必须包含名称、命令和 execute/fill 模式");
  }
  return normalized as Shortcut[];
}

export function moveShortcut(items: Shortcut[], index: number, delta: -1 | 1): Shortcut[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
