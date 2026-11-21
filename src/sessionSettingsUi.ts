import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { attachBaudPicker, type SerialConfig } from "./serialUi";
import { enableDialogDrag, resetDialogPosition } from "./modalDrag";
import { applyStaticI18n, onLocaleChange, t } from "./i18n";
import { clampFontSize, DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./displaySettings";

export interface SessionSettings {
  cr_as_newline: boolean;
  console_timestamps: boolean;
  file_timestamps: boolean;
  timestamp_format: string;
  log_directory: string | null;
  log_filename: string;
  logging: boolean;
  /// 暂停/继续（串口是断开/连接）时换一个新的日志文件。
  new_log_on_toggle: boolean;
  /// 终端字号：跟着会话走，全局设置里没有这一项。
  font_size: number;
}

export interface SessionSettingsResponse {
  settings: SessionSettings;
  serial: SerialConfig | null;
}

interface SessionSettingsDeps {
  saved(id: string): void;
  /// 字号改了：立刻作用到终端（不必等保存）
  fontSizePreview(id: string, size: number): void;
}

const DEFAULT_SETTINGS: SessionSettings = {
  cr_as_newline: false,
  console_timestamps: false,
  file_timestamps: false,
  timestamp_format: "yyyy-MM-dd HH:mm:ss.SSS",
  log_directory: null,
  log_filename: "%Y%M%D-%h%m%s.log",
  logging: false,
  new_log_on_toggle: false,
  font_size: DEFAULT_FONT_SIZE
};

export function setupSessionSettingsUi(deps: SessionSettingsDeps) {
  const overlay = document.createElement("div");
  overlay.className = "session-settings-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <form class="session-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="session-settings-title" tabindex="-1" autocomplete="off">
      <header><h2 id="session-settings-title" data-i18n="sessionSettings.title">会话设置</h2><button type="button" class="session-settings-close" data-i18n-aria="sessionSettings.close">×</button></header>
      <div class="session-settings-body">
        <section><h3 data-i18n="sessionSettings.sectionDisplay">终端显示</h3>
          <label><span data-i18n="sessionSettings.fontSize">字体大小</span><input name="font_size" type="number" min="${MIN_FONT_SIZE}" max="${MAX_FONT_SIZE}" step="1" autocomplete="off"></label>
        </section>
        <section><h3 data-i18n="sessionSettings.sectionTerminal">终端与时间</h3>
          <label><span data-i18n="sessionSettings.crAsNewline">回车作为换行</span><input name="cr_as_newline" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.consoleTimestamps">控制台显示时间戳</span><input name="console_timestamps" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.fileTimestamps">文件记录时间戳</span><input name="file_timestamps" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.timestampFormat">时间戳格式</span><input name="timestamp_format" type="text" autocomplete="off" spellcheck="false" data-i18n-title="sessionSettings.timestampFormatHint"></label>
        </section>
        <section><h3 data-i18n="sessionSettings.sectionLog">日志</h3>
          <label><span data-i18n="sessionSettings.logging">记录会话日志</span><input name="logging" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.newLogOnToggle">暂停/继续（连接/断开）时新建日志文件</span><input name="new_log_on_toggle" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.logFilename">日志文件名</span><input name="log_filename" type="text" autocomplete="off" spellcheck="false"></label>
          <div class="session-settings-path"><span id="session-log-directory-label" data-i18n="sessionSettings.logDirectory">日志目录</span><div class="session-settings-path-field"><input id="session-log-directory" name="log_directory" type="text" autocomplete="off" spellcheck="false" aria-labelledby="session-log-directory-label"><button type="button" data-action="browse" data-i18n="sessionSettings.browse">浏览</button><button type="button" data-action="open-dir" data-i18n="sessionSettings.open">打开</button></div></div>
        </section>
        <section class="session-settings-serial"><h3 data-i18n="sessionSettings.sectionSerial">串口参数</h3>
          <label><span data-i18n="sessionSettings.port">端口</span><input name="port" type="text" autocomplete="off" readonly data-i18n-title="sessionSettings.portHint"></label>
          <label><span data-i18n="sessionSettings.baud">波特率</span><span class="baud-field"><input name="baud" type="number" min="1" step="1" autocomplete="off" data-i18n-title="serial.baudHint"><button type="button" data-action="baud-pick" data-i18n-title="serial.baudPick" data-i18n-aria="serial.baudPick" aria-haspopup="menu">▾</button></span></label>
          <label><span data-i18n="sessionSettings.dataBits">数据位</span><select name="data_bits"><option>5</option><option>6</option><option>7</option><option>8</option></select></label>
          <label><span data-i18n="sessionSettings.parity">校验位</span><select name="parity"><option value="none" data-i18n="serial.parityNone">无</option><option value="odd" data-i18n="serial.parityOdd">奇</option><option value="even" data-i18n="serial.parityEven">偶</option></select></label>
          <label><span data-i18n="sessionSettings.stopBits">停止位</span><select name="stop_bits"><option value="one">1</option><option value="two">2</option></select></label>
          <label><span data-i18n="sessionSettings.flow">流控</span><select name="flow"><option value="none" data-i18n="sessionSettings.flowNone">无</option><option value="software" data-i18n="sessionSettings.flowSoftware">软件</option><option value="hardware" data-i18n="sessionSettings.flowHardware">硬件</option></select></label>
          <label><span>DTR</span><input name="dtr" type="checkbox"></label>
          <label><span>RTS</span><input name="rts" type="checkbox"></label>
          <label><span data-i18n="sessionSettings.lineEnding">发送行尾</span><select name="line_ending"><option value="crlf">CRLF</option><option value="cr">CR</option><option value="lf">LF</option></select></label>
          <label><span data-i18n="sessionSettings.sendMode">发送模式</span><select name="send_mode"><option value="line" data-i18n="sessionSettings.modeLine">按行</option><option value="direct" data-i18n="sessionSettings.modeDirect">直接</option></select></label>
        </section>
      </div>
      <div class="session-settings-error" role="alert" aria-live="polite"></div>
      <footer><button type="button" data-action="cancel" data-i18n="sessionSettings.cancel">取消</button><button type="submit" data-action="save" data-i18n="sessionSettings.save">保存</button></footer>
    </form>`;
  document.body.append(overlay);
  attachBaudPicker(
    overlay.querySelector<HTMLInputElement>('input[name="baud"]')!,
    overlay.querySelector<HTMLButtonElement>('[data-action="baud-pick"]')!
  );
  const form = overlay.querySelector("form")!;
  enableDialogDrag(form.querySelector("header")!, form);
  const titleEl = overlay.querySelector("h2")!;
  const errorEl = overlay.querySelector<HTMLElement>(".session-settings-error")!;
  const serialSection = overlay.querySelector<HTMLElement>(".session-settings-serial")!;
  let currentId = "";
  let currentTitle = "";
  let serialEnabled = false;
  let token = 0;
  let loaded = false;
  let busy = false;

  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;
  const readSettings = (): SessionSettings => ({
    cr_as_newline: field<HTMLInputElement>("cr_as_newline").checked,
    console_timestamps: field<HTMLInputElement>("console_timestamps").checked,
    file_timestamps: field<HTMLInputElement>("file_timestamps").checked,
    timestamp_format: field<HTMLInputElement>("timestamp_format").value,
    log_directory: field<HTMLInputElement>("log_directory").value.trim() || null,
    log_filename: field<HTMLInputElement>("log_filename").value,
    logging: field<HTMLInputElement>("logging").checked,
    new_log_on_toggle: field<HTMLInputElement>("new_log_on_toggle").checked,
    font_size: clampFontSize(Number(field<HTMLInputElement>("font_size").value))
  });
  const readSerial = (): SerialConfig | null => {
    if (!serialEnabled) return null;
    return {
      port: field<HTMLInputElement>("port").value.trim(),
      baud: Number(field<HTMLInputElement>("baud").value),
      data_bits: Number(field<HTMLSelectElement>("data_bits").value),
      parity: field<HTMLSelectElement>("parity").value as SerialConfig["parity"],
      stop_bits: field<HTMLSelectElement>("stop_bits").value as SerialConfig["stop_bits"],
      flow: field<HTMLSelectElement>("flow").value as SerialConfig["flow"],
      dtr: field<HTMLInputElement>("dtr").checked,
      rts: field<HTMLInputElement>("rts").checked,
      line_ending: field<HTMLSelectElement>("line_ending").value as SerialConfig["line_ending"],
      send_mode: field<HTMLSelectElement>("send_mode").value as SerialConfig["send_mode"]
    };
  };
  function load(data: SessionSettingsResponse) {
    const s = { ...DEFAULT_SETTINGS, ...data.settings };
    for (const name of ["cr_as_newline", "console_timestamps", "file_timestamps", "logging", "new_log_on_toggle"] as const) field<HTMLInputElement>(name).checked = s[name];
    for (const name of ["timestamp_format", "log_filename"] as const) field<HTMLInputElement>(name).value = s[name];
    field<HTMLInputElement>("font_size").value = String(clampFontSize(s.font_size));
    field<HTMLInputElement>("log_directory").value = s.log_directory ?? "";
    serialEnabled = data.serial !== null;
    serialSection.hidden = !serialEnabled;
    if (data.serial) {
      for (const name of ["port"] as const) field<HTMLInputElement>(name).value = data.serial[name];
      field<HTMLInputElement>("baud").value = String(data.serial.baud);
      for (const name of ["data_bits", "parity", "stop_bits", "flow", "line_ending", "send_mode"] as const) field<HTMLSelectElement>(name).value = String(data.serial[name]);
      for (const name of ["dtr", "rts"] as const) field<HTMLInputElement>(name).checked = data.serial[name];
    }
  }
  function paintTitle() {
    titleEl.textContent = currentTitle
      ? t("sessionSettings.titleOf", { title: currentTitle })
      : t("sessionSettings.title");
  }
  function close() { if (!busy) overlay.hidden = true; }
  overlay.querySelector(".session-settings-close")!.addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]')!.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  // 打开时焦点可能还留在终端/输入条里，keydown 不会经过 overlay：
  // 与全局设置一样，Esc 在任何位置都要能关掉这个对话框。
  // 若此刻开着波特率菜单，popupMenu 会在捕获阶段吃掉 Esc，不会连带关掉对话框。
  window.addEventListener("keydown", (event) => {
    if (overlay.hidden || event.key !== "Escape") return;
    event.preventDefault();
    close();
  });
  overlay.querySelector('[data-action="browse"]')!.addEventListener("click", async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, defaultPath: field<HTMLInputElement>("log_directory").value || undefined });
      if (typeof selected === "string") field<HTMLInputElement>("log_directory").value = selected;
    } catch (err) { errorEl.textContent = String(err); }
  });
  overlay.querySelector('[data-action="open-dir"]')!.addEventListener("click", async () => {
    const path = field<HTMLInputElement>("log_directory").value.trim();
    if (!path) { errorEl.textContent = t("sessionSettings.needPath"); return; }
    try { await invoke("fs_open", { path }); } catch (err) { errorEl.textContent = String(err); }
  });
  // 字号是「所见即所得」：改完立刻作用到终端，保存只是把它落盘
  field<HTMLInputElement>("font_size").addEventListener("change", () => {
    const size = clampFontSize(Number(field<HTMLInputElement>("font_size").value));
    field<HTMLInputElement>("font_size").value = String(size);
    if (currentId) deps.fontSizePreview(currentId, size);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!loaded) { errorEl.textContent = t("sessionSettings.notLoaded"); return; }
    const serial = readSerial();
    if (serial && (!serial.port || !Number.isSafeInteger(serial.baud) || serial.baud <= 0)) {
      errorEl.textContent = t("sessionSettings.invalidSerial");
      return;
    }
    busy = true;
    const saveButton = form.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    saveButton.disabled = true;
    errorEl.textContent = "";
    try {
      await invoke("session_settings_save", { id: currentId, settings: readSettings(), serial });
      overlay.hidden = true;
      deps.saved(currentId);
    } catch (err) {
      errorEl.textContent = String(err);
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  });

  // 语言变了：静态标注由 main 统一刷，这里补标题（标题带会话名，不能纯静态）
  onLocaleChange(() => {
    applyStaticI18n(overlay);
    paintTitle();
  });

  return {
    async open(id: string, title: string, hasSerial: boolean) {
      currentId = id;
      currentTitle = title;
      loaded = false;
      const mine = ++token;
      serialEnabled = hasSerial;
      serialSection.hidden = !hasSerial;
      applyStaticI18n(overlay);
      paintTitle();
      errorEl.textContent = t("sessionSettings.loading");
      resetDialogPosition(form);
      overlay.hidden = false;
      // 打开时把焦点收进对话框：Esc/Tab 都落在对话框里，
      // 不会顺手清掉输入条里的内容，也不需要先点一下才能用键盘
      form.focus();
      try {
        const response = await invoke<SessionSettingsResponse>("session_settings_get", { id });
        if (mine !== token) return;
        load(response);
        loaded = true;
        errorEl.textContent = "";
      } catch (err) {
        if (mine === token) {
          loaded = false;
          errorEl.textContent = String(err);
        }
      }
    }
  };
}
