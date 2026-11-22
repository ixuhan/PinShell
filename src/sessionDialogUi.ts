// 新建会话弹窗：终端与串口共用一张表单。
//
// 它只负责收集参数并把「创建」交给核心（ADR 0008）：
// - 传输方式决定显示终端段（Shell / 起始目录）还是串口段（端口 / 8N1 参数）；
// - 落点也在这里选，项目为空时固定填第一格、下拉不出现；
// - 校验与默认值不在这里复制：端口被占用、波特率越界、目录不存在都由 Rust 返回原文，
//   这个模块只把错误显示出来并保持打开，让用户改了重试。

import { invoke } from "@tauri-apps/api/core";
import { enableDialogDrag, resetDialogPosition } from "./modalDrag";
import { applyStaticI18n, onLocaleChange, t } from "./i18n";
import { showPopupMenu, type PopupItem } from "./popupMenu";

export interface SerialConfig {
  port: string;
  baud: number;
  data_bits: number;
  parity: "none" | "odd" | "even";
  stop_bits: "one" | "two";
  flow: "none" | "software" | "hardware";
  dtr: boolean;
  rts: boolean;
  line_ending: "crlf" | "cr" | "lf";
  send_mode: "line" | "direct";
}

export interface SerialPort {
  port: string;
  kind: "usb" | "pci" | "bluetooth" | "unknown" | "virtual";
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
  friendly_name?: string | null;
}

export interface TerminalProfile {
  id: string;
  title: string;
  command: string;
}

export type TransportChoice = "terminal" | "serial";
export type PlacementChoice = "fill" | "right" | "down" | "replace";

export interface NewSessionRequest {
  transport: TransportChoice;
  /// 空串 = 用 Shell / 端口默认名
  title: string;
  /// 终端通道
  shell: string | null;
  cwd: string | null;
  /// 串口通道
  serial: SerialConfig | null;
  placement: PlacementChoice;
}

/// 常用波特率：既用于「新建会话」的串口段，也用于会话设置。
/// 输入框旁边带一个自绘下拉（见 `attachBaudPicker`）：可以从这里挑，也可以直接敲一个别的值
/// （校验只在核心做）。
export const COMMON_BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600
] as const;

/// 给波特率输入框接上一个自绘下拉。
///
/// 不用原生 `<datalist>`：它的下拉由系统绘制，暗色主题下是一块突兀的灰色面板，
/// 字体与圆角都和应用对不上。这里复用全应用共用的 `popupMenu`，
/// 选中后直接填回输入框，输入框本身仍然可以自由编辑。
export function attachBaudPicker(input: HTMLInputElement, button: HTMLButtonElement): void {
  // 点面板不该把焦点从终端/输入条抢走
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    const current = Number.parseInt(input.value, 10);
    showPopupMenu(
      button,
      COMMON_BAUD_RATES.map((rate) => ({
        label: String(rate),
        checked: rate === current,
        run: () => {
          input.value = String(rate);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.focus();
          input.select();
        }
      })),
      { minWidth: 132 }
    );
  });
}

export interface SessionDialogDeps {
  /// 真正创建会话。抛错即显示在对话框里、保持打开，让用户改参数重试。
  create(request: NewSessionRequest): Promise<void>;
  /// Shell profile 列表来自核心（`terminal_profiles`），弹窗本身不猜。
  shellProfiles(): Promise<TerminalProfile[]>;
}

export interface SessionDialogOpenOptions {
  /// 项目里已经有格子：显示落点下拉并默认「向右切」；空项目固定填第一格。
  hasPanes: boolean;
}

/// 端口种类名。USB / PCI 是通用缩写，两种语言下都保持原样。
function kindLabel(kind: SerialPort["kind"]): string {
  switch (kind) {
    case "bluetooth": return t("serial.bluetooth");
    case "virtual": return t("serial.virtual");
    case "unknown": return t("serial.unknown");
    default: return kind.toUpperCase();
  }
}

/// 端口下拉里的一行文案：`COM3 · USB 串行设备`。
export function portLabel(port: SerialPort): string {
  const detail = port.friendly_name || port.product || port.manufacturer || kindLabel(port.kind) || port.kind;
  return `${port.port} · ${detail}`;
}

export function setupSessionDialog(deps: SessionDialogDeps) {
  const overlay = document.getElementById("session-overlay") as HTMLDivElement;
  const form = document.getElementById("session-form") as HTMLFormElement;
  const nameInput = document.getElementById("session-name") as HTMLInputElement;
  const shellSelect = document.getElementById("session-shell") as HTMLSelectElement;
  const cwdInput = document.getElementById("session-cwd") as HTMLInputElement;
  const placementField = document.getElementById("session-placement-field") as HTMLElement;
  const placementSelect = document.getElementById("session-placement") as HTMLSelectElement;
  const placementHint = document.getElementById("session-placement-hint") as HTMLElement;
  const terminalSection = document.getElementById("session-terminal") as HTMLElement;
  const serialGrid = document.getElementById("serial-grid") as HTMLElement;
  const serialFlags = document.getElementById("serial-flags") as HTMLElement;
  const transportInputs = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="transport"]')
  ];
  const portInput = document.getElementById("serial-port") as HTMLInputElement;
  const portPick = document.getElementById("serial-port-pick") as HTMLButtonElement;
  const baudInput = document.getElementById("serial-baud") as HTMLInputElement;
  attachBaudPicker(baudInput, document.getElementById("serial-baud-pick") as HTMLButtonElement);
  const dataBits = document.getElementById("serial-data") as HTMLSelectElement;
  const parity = document.getElementById("serial-parity") as HTMLSelectElement;
  const stopBits = document.getElementById("serial-stop") as HTMLSelectElement;
  const flow = document.getElementById("serial-flow") as HTMLSelectElement;
  const dtr = document.getElementById("serial-dtr") as HTMLInputElement;
  const rts = document.getElementById("serial-rts") as HTMLInputElement;
  const ending = document.getElementById("serial-ending") as HTMLSelectElement;
  const sendMode = document.getElementById("serial-mode") as HTMLSelectElement;
  const errorEl = document.getElementById("session-error") as HTMLDivElement;
  const createBtn = document.getElementById("session-create") as HTMLButtonElement;
  const closeBtn = document.getElementById("session-close") as HTMLButtonElement;
  const cancelBtn = document.getElementById("session-cancel") as HTMLButtonElement;
  enableDialogDrag(document.getElementById("session-head")!, form);

  let busy = false;
  let profiles: TerminalProfile[] = [];

  function transport(): TransportChoice {
    return transportInputs.find((input) => input.checked)?.value === "serial" ? "serial" : "terminal";
  }

  function setError(text: string) {
    errorEl.textContent = text;
  }

  function isOpen(): boolean {
    return !overlay.hidden;
  }

  /// 传输方式决定显示哪一段；串口段的 DTR/RTS 与提示一起换。
  function paintTransport() {
    const serial = transport() === "serial";
    terminalSection.hidden = serial;
    serialGrid.hidden = !serial;
    serialFlags.hidden = !serial;
    placementHint.hidden = serial || placementSelect.value !== "replace";
  }

  function paintPlacementHint() {
    placementHint.hidden = transport() === "serial" || placementSelect.value !== "replace";
  }

  /// Shell 已有哪些就列哪些；核心给空列表时留一个「默认」，由后端解析默认 Shell。
  async function loadProfiles() {
    profiles = await deps.shellProfiles().catch(() => []);
    const previous = shellSelect.value;
    shellSelect.textContent = "";
    if (!profiles.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("sessionDialog.defaultShell");
      shellSelect.append(option);
      return;
    }
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.command;
      option.textContent = profile.title;
      shellSelect.append(option);
    }
    if (previous && profiles.some((profile) => profile.command === previous)) {
      shellSelect.value = previous;
    }
  }

  /// 端口下拉：每次点开都现枚举一次，设备刚插上也能直接选，不必先刷串口列表。
  async function pickPort() {
    portPick.disabled = true;
    let ports: SerialPort[] = [];
    let failed = false;
    try {
      ports = await invoke<SerialPort[]>("serial_ports");
    } catch {
      failed = true;
    } finally {
      portPick.disabled = false;
    }
    const items: PopupItem[] = failed
      ? [{ label: t("sidebar.portsFailed"), disabled: true }]
      : ports.length
        ? ports.map((port) => ({
            label: portLabel(port),
            checked: port.port === portInput.value.trim(),
            run: () => {
              portInput.value = port.port;
              portInput.dispatchEvent(new Event("input", { bubbles: true }));
              portInput.dispatchEvent(new Event("change", { bubbles: true }));
              portInput.focus();
            }
          }))
        : [{ label: t("sidebar.portsEmpty"), disabled: true }];
    showPopupMenu(portPick, items, { minWidth: 200 });
  }

  portPick.addEventListener("mousedown", (event) => event.preventDefault());
  portPick.addEventListener("click", () => void pickPort());

  async function open(options: SessionDialogOpenOptions) {
    if (busy) return;
    setError("");
    nameInput.value = "";
    cwdInput.value = "";
    const terminalInput = transportInputs.find((input) => input.value === "terminal");
    if (terminalInput) terminalInput.checked = true;
    // 空项目没有「当前格」可替换/切分：固定填第一格，落点下拉直接不出现
    placementSelect.value = options.hasPanes ? "right" : "fill";
    placementField.hidden = !options.hasPanes;
    paintTransport();
    if (!isOpen()) {
      resetDialogPosition(form);
      overlay.hidden = false;
    }
    await loadProfiles();
    nameInput.focus();
    if (transport() === "serial" && portInput.value.trim()) {
      baudInput.focus();
      baudInput.select();
    }
    if (!portInput.value.trim()) {
      void invoke<SerialPort[]>("serial_ports")
        .then((ports) => {
          if (!portInput.value.trim() && ports.length) portInput.value = ports[0].port;
        })
        .catch(() => undefined);
    }
  }

  function close() {
    if (busy) return; // 正在创建：让结果回来再关，避免创建了却没有界面接管
    overlay.hidden = true;
    setError("");
  }

  function readSerial(): SerialConfig | string {
    const port = portInput.value.trim();
    if (!port) return t("serial.portRequired");
    const baud = Number.parseInt(baudInput.value, 10);
    if (!Number.isFinite(baud) || baud <= 0) return t("serial.baudRequired");
    return {
      port,
      baud,
      data_bits: Number.parseInt(dataBits.value, 10),
      parity: parity.value as SerialConfig["parity"],
      stop_bits: stopBits.value as SerialConfig["stop_bits"],
      flow: flow.value as SerialConfig["flow"],
      dtr: dtr.checked,
      rts: rts.checked,
      line_ending: ending.value as SerialConfig["line_ending"],
      send_mode: sendMode.value as SerialConfig["send_mode"]
    };
  }

  async function submit() {
    if (busy) return;
    const kind = transport();
    const placement = placementSelect.value as PlacementChoice;
    let request: NewSessionRequest;
    if (kind === "serial") {
      const serial = readSerial();
      if (typeof serial === "string") {
        setError(serial);
        baudInput.focus();
        return;
      }
      request = {
        transport: "serial",
        title: nameInput.value.trim(),
        shell: null,
        cwd: null,
        serial,
        placement
      };
    } else {
      request = {
        transport: "terminal",
        title: nameInput.value.trim(),
        shell: shellSelect.value || null,
        cwd: cwdInput.value.trim() || null,
        serial: null,
        placement
      };
    }
    busy = true;
    createBtn.disabled = true;
    createBtn.textContent = t("sessionDialog.creating");
    setError("");
    try {
      await deps.create(request);
      busy = false;
      createBtn.disabled = false;
      createBtn.textContent = t("serial.create");
      overlay.hidden = true;
    } catch (err) {
      busy = false;
      createBtn.disabled = false;
      createBtn.textContent = t("serial.create");
      setError(String(err));
    }
  }

  for (const input of transportInputs) {
    input.addEventListener("change", paintTransport);
  }
  placementSelect.addEventListener("change", paintPlacementHint);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  // 对话框里的按键不往外走：Esc 关闭，Enter 交给表单提交（textarea 才会换行，这里没有）
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  // 「创建」按钮不抢焦点：提交后错误信息还在，用户可以直接改参数再回车
  createBtn.addEventListener("mousedown", (event) => event.preventDefault());

  // 语言变了：静态标注由 main 统一刷，这里补动态文案与 Shell 列表
  onLocaleChange(() => {
    applyStaticI18n(overlay);
    if (!busy) createBtn.textContent = t("serial.create");
    void loadProfiles();
  });

  return { open, close, isOpen };
}
