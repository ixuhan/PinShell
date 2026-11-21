import { t } from "./i18n";

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
/// 快捷指令最多占右栏内容区的七成：与左栏「串口」拖高的上限一致，留给另一栏的空间可以压得很低。
export const MAX_SHORTCUT_RATIO = 0.7;

/// 夹取快捷指令区高度。规则与左栏的串口拖高对齐：
/// 下限 120px，上限为可用高度的 70%；不再额外给文件栏留固定 160px，
/// 否则快捷指令最多只能到一半，另一栏永远压不下去。
export function clampShortcutHeight(value: number, available: number): number {
  const max = Math.max(MIN_SHORTCUT_HEIGHT, Math.floor(available * MAX_SHORTCUT_RATIO));
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
  if (!items) throw new Error(t("shortcuts.badShape"));
  const normalized = items.map(normalizeShortcut);
  if (normalized.some((item) => item === null)) {
    throw new Error(t("shortcuts.badItem"));
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
