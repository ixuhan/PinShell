// 全局设置：语言、主题、版本号与更新检查。
//
// 只放**应用级**偏好——终端字号这类跟着会话走的东西在会话设置里。
// 三块内容各自独立：
// - 语言：写 `i18n` 的 locale 并广播，各模块重画自己的文案；
// - 主题：写 `<html data-theme>` 与 localStorage，同时换 xterm 配色；
// - 版本与更新：版本号来自 Tauri，检查更新按钮在未配置签名源时明确说明。

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { applyStaticI18n, getLocale, onLocaleChange, setLocale, t, type Locale } from "./i18n";
import { applyTheme, parseTheme, readTheme, saveTheme, type Theme } from "./theme";
import { enableDialogDrag, resetDialogPosition } from "./modalDrag";

export interface GlobalSettingsDeps {
  /// 主题变了：让终端换一套 canvas 配色
  themeChanged(theme: Theme): void;
}

export interface GlobalSettingsHandle {
  open(): void;
  close(): void;
}

export function setupGlobalSettings(deps: GlobalSettingsDeps): GlobalSettingsHandle {
  const overlay = document.getElementById("settings-overlay") as HTMLDivElement;
  const dialog = document.getElementById("settings-dialog") as HTMLElement;
  const closeBtn = document.getElementById("settings-close") as HTMLButtonElement;
  const doneBtn = document.getElementById("settings-done") as HTMLButtonElement;
  const languageSelect = document.getElementById("setting-language") as HTMLSelectElement;
  const themeSelect = document.getElementById("setting-theme") as HTMLSelectElement;
  const versionEl = document.getElementById("settings-version") as HTMLSpanElement;
  const checkBtn = document.getElementById("settings-check-update") as HTMLButtonElement;
  const statusEl = document.getElementById("update-status") as HTMLSpanElement;

  let version = "";
  let busy = false;

  function paintVersion() {
    versionEl.textContent = version ? t("globalSettings.version", { version }) : "";
  }

  function paintControls() {
    languageSelect.value = getLocale();
    themeSelect.value = readTheme();
    applyStaticI18n(overlay);
    paintVersion();
  }

  function close() {
    overlay.hidden = true;
  }

  async function runUpdateCheck() {
    if (busy) return;
    busy = true;
    checkBtn.disabled = true;
    statusEl.textContent = t("globalSettings.checking");
    try {
      // 没有配置签名公钥时插件根本没注册：先问后端，别让 check() 抛一个难懂的错
      const configured = await invoke<boolean>("updater_configured");
      if (!configured) {
        statusEl.textContent = t("globalSettings.notConfigured");
        return;
      }
      const update: Update | null = await check();
      statusEl.textContent = update
        ? t("globalSettings.updateAvailable", { version: update.version })
        : t("globalSettings.upToDate");
    } catch (err) {
      statusEl.textContent = t("globalSettings.updateFailed", { error: String(err) });
    } finally {
      busy = false;
      checkBtn.disabled = false;
    }
  }

  closeBtn.addEventListener("click", close);
  // 标题栏就是拖动把手：与新建串口会话、会话设置、快捷指令几个弹窗同一套手势
  enableDialogDrag(dialog.querySelector("header")!, dialog);
  doneBtn.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
  });
  checkBtn.addEventListener("click", () => void runUpdateCheck());

  languageSelect.addEventListener("change", () => {
    setLocale(languageSelect.value === "en" ? "en" : "zh");
  });
  themeSelect.addEventListener("change", () => {
    const theme = parseTheme(themeSelect.value);
    saveTheme(theme);
    applyTheme(theme);
    deps.themeChanged(theme);
  });

  // 语言一变，这个对话框自己的文案也要跟着换
  onLocaleChange((locale: Locale) => {
    void locale;
    paintControls();
  });

  void getVersion()
    .then((value) => {
      version = value;
      paintVersion();
    })
    .catch(() => {
      version = "";
      paintVersion();
    });

  paintControls();

  return {
    open() {
      paintControls();
      statusEl.textContent = "";
      // 每次都回到居中：上次拖到的位置在窗口变小后可能已经在屏幕外
      resetDialogPosition(dialog);
      overlay.hidden = false;
      languageSelect.focus();
    },
    close
  };
}
