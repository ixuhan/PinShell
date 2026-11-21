// 新建串口会话的对话框：只负责收集参数并把「创建」交给核心。
//
// 校验与默认值都不在这里复制：波特率越界、端口被占用等错误由 Rust 侧返回，
// 这个模块只把原文显示出来（见 `core_domain::serial` 与 `spawn_serial_session`）。
// 端口不由这里选择：会话就是在某个具体串口上创建的，调用方（左侧串口列表）把端口传进来，
// 输入框只读显示，避免「列表点的是 COM3、创建出来的却是 COM5」这种错位。

import { enableDialogDrag, resetDialogPosition } from "./modalDrag";
import { applyStaticI18n, onLocaleChange, t } from "./i18n";
import { showPopupMenu } from "./popupMenu";

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

/// 常用波特率：既用于「新建串口会话」，也用于会话设置。
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

export interface SerialDialogDeps {
  /// 真正创建会话。抛错即显示在对话框里、保持打开，让用户改参数重试。
  create(config: SerialConfig): Promise<string>;
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

export function setupSerialDialog(deps: SerialDialogDeps) {
  const overlay = document.getElementById("serial-overlay") as HTMLDivElement;
  const form = document.getElementById("serial-form") as HTMLFormElement;
  const portInput = document.getElementById("serial-port") as HTMLInputElement;
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
  const errorEl = document.getElementById("serial-error") as HTMLDivElement;
  const createBtn = document.getElementById("serial-create") as HTMLButtonElement;
  const closeBtn = document.getElementById("serial-close") as HTMLButtonElement;
  const cancelBtn = document.getElementById("serial-cancel") as HTMLButtonElement;
  enableDialogDrag(document.getElementById("serial-head")!, form);

  let busy = false;

  function setError(text: string) {
    errorEl.textContent = text;
  }

  function isOpen(): boolean {
    return !overlay.hidden;
  }

  /// `port` 是必填：对话框不再枚举端口，端口由调用方指定。
  function open(port: string) {
    if (busy) return;
    if (port) portInput.value = port;
    setError("");
    if (isOpen()) return;
    resetDialogPosition(form);
    overlay.hidden = false;
    // 端口不可编辑，焦点给第一个能改的字段，用户直接输参数就能回车创建
    baudInput.focus();
    baudInput.select();
  }

  function close() {
    if (busy) return; // 正在打开端口：让结果回来再关，避免创建了却没有界面接管
    overlay.hidden = true;
    setError("");
  }

  function readConfig(): SerialConfig | string {
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
    const config = readConfig();
    if (typeof config === "string") {
      setError(config);
      baudInput.focus();
      return;
    }
    busy = true;
    createBtn.disabled = true;
    createBtn.textContent = t("serial.connecting");
    setError("");
    try {
      await deps.create(config);
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

  // 语言变了：静态标注由 main 统一刷，这里补「创建」按钮的当前文字
  onLocaleChange(() => {
    applyStaticI18n(overlay);
    if (!busy) createBtn.textContent = t("serial.create");
  });

  return { open, close, isOpen };
}
