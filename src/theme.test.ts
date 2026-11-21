import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, isLight, parseTheme, readTheme, saveTheme, THEMES, xtermTheme } from "./theme";

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  });
  const root = {
    lang: "",
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>
  };
  vi.stubGlobal("document", { documentElement: root });
  return { store, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("主题偏好", () => {
  it("九套主题都能解析回来，旧的 light 归到乳白，其余一律按暗黑", () => {
    expect(THEMES).toHaveLength(9);
    expect(new Set(THEMES).size).toBe(9);
    for (const theme of THEMES) expect(parseTheme(theme)).toBe(theme);

    expect(parseTheme("light")).toBe("cream");
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme("")).toBe("dark");
    expect(parseTheme("sepia")).toBe("dark");
  });

  it("读写 localStorage，读不到时回退暗黑", () => {
    const { store } = stubStorage();
    expect(readTheme()).toBe("dark");
    saveTheme("midnight");
    expect(store.get("pinshell.theme")).toBe("midnight");
    expect(readTheme()).toBe("midnight");
    saveTheme("paper");
    expect(readTheme()).toBe("paper");
  });

  it("存储被禁用时不影响使用", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      }
    });
    expect(readTheme()).toBe("dark");
    expect(() => saveTheme("bright")).not.toThrow();
  });

  it("applyTheme 写 data-theme 与 color-scheme：四套暗色写 dark，五套亮色写 light", () => {
    const { root } = stubStorage();
    for (const theme of THEMES) {
      applyTheme(theme);
      expect(root.dataset.theme).toBe(theme);
      expect(root.style.colorScheme).toBe(isLight(theme) ? "light" : "dark");
    }
    // 边界抽查：新加的深空蓝仍是深色，素纸是亮色
    expect(isLight("midnight")).toBe(false);
    expect(isLight("ember")).toBe(false);
    expect(isLight("nord")).toBe(false);
    expect(isLight("sand")).toBe(true);
    expect(isLight("mist")).toBe(true);
    expect(isLight("paper")).toBe(true);
  });
});

describe("终端配色", () => {
  it("九套主题的底色与前景两两不同，且都给出完整的 16 色", () => {
    const themes = THEMES.map((theme) => xtermTheme(theme));
    const backgrounds = new Set(themes.map((theme) => theme.background));
    const foregrounds = new Set(themes.map((theme) => theme.foreground));
    expect(backgrounds.size).toBe(THEMES.length);
    expect(foregrounds.size).toBe(THEMES.length);
    for (const theme of themes) {
      for (const key of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
        expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/i);
        expect(theme[`bright${key[0].toUpperCase()}${key.slice(1)}`]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("每次返回新对象，调用方改它不会污染缓存", () => {
    const first = xtermTheme("dark");
    first.background = "#123456";
    expect(xtermTheme("dark").background).not.toBe("#123456");
  });
});
