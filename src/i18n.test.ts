import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale, t } from "./i18n";

// i18n 会写 localStorage / document.documentElement：这里只需要最少的桩，
// 不引入 jsdom，保持 L0 测试的启动成本。
function stubEnv() {
  const store = new Map<string, string>();
  const listeners = new Set<(event: Event) => void>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  });
  vi.stubGlobal("document", {
    documentElement: {
      lang: "",
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      addEventListener: (type: string, fn: (event: Event) => void) => listeners.add(fn),
      removeEventListener: (type: string, fn: (event: Event) => void) => listeners.delete(fn)
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("zh");
});

describe("i18n 文案", () => {
  it("默认中文，取到中文原文", () => {
    stubEnv();
    expect(getLocale()).toBe("zh");
    expect(t("globalSettings.title")).toBe("全局设置");
    expect(t("sessionSettings.fontSize")).toBe("字体大小");
  });

  it("切到英文后取到英文译文，并写进 localStorage", () => {
    stubEnv();
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("globalSettings.title")).toBe("Global settings");
    expect(t("sessionSettings.fontSize")).toBe("Font size");
    expect(localStorage.getItem("pinshell.locale")).toBe("en");
  });

  it("占位符按名字替换，缺失的保持原样", () => {
    stubEnv();
    expect(t("history.count", { n: 12 })).toBe("12 条");
    expect(t("sessionSettings.titleOf", { title: "pwsh" })).toBe("会话设置 · pwsh");
    // 没传的占位符不炸，原样留着便于发现漏填
    expect(t("history.count", {})).toBe("{n} 条");
  });

  it("未知键退回键名，不会显示 undefined", () => {
    stubEnv();
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });

  it("切语言会同步 <html lang>", () => {
    stubEnv();
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
    setLocale("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
