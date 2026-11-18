// 新建串口会话的对话框：只负责收集参数并把「创建」交给核心。
//
// 校验与默认值都不在这里复制：端口为空、波特率越界、端口被占用等错误由 Rust 侧
// 返回，这个模块只把原文显示出来（见 `core_domain::serial` 与 `spawn_serial_session`）。
// 端口枚举走 `serial_ports`，只用于下拉建议；用户仍然可以手输 COM 口名。

import { invoke } from "@tauri-apps/api/core";

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
}

export interface SerialDialogDeps {
  /// 真正创建会话。抛错即显示在对话框里、保持打开，让用户改参数重试。
  create(config: SerialConfig): Promise<string>;
}

const KIND_LABEL: Record<SerialPort["kind"], string> = {
  usb: "USB",
  pci: "PCI",
  bluetooth: "蓝牙",
  unknown: "未知",
  virtual: "虚拟"
};

/// 端口下拉里的一行文案：`COM3 · USB 串行设备`。
export function portLabel(port: SerialPort): string {
  const detail = port.product || port.manufacturer || KIND_LABEL[port.kind] || port.kind;
  return `${port.port} · ${detail}`;
}

export function setupSerialDialog(deps: SerialDialogDeps) {
  const overlay = document.getElementById("serial-overlay") as HTMLDivElement;
  const form = document.getElementById("serial-form") as HTMLFormElement;
  const portInput = document.getElementById("serial-port") as HTMLInputElement;
  const portList = document.getElementById("serial-port-list") as HTMLDataListElement;
  const baudInput = document.getElementById("serial-baud") as HTMLInputElement;
  const dataBits = document.getElementById("serial-data") as HTMLSelectElement;
  const parity = document.getElementById("serial-parity") as HTMLSelectElement;
  const stopBits = document.getElementById("serial-stop") as HTMLSelectElement;
  const flow = document.getElementById("serial-flow") as HTMLSelectElement;
  const dtr = document.getElementById("serial-dtr") as HTMLInputElement;
  const rts = document.getElementById("serial-rts") as HTMLInputElement;
  const ending = document.getElementById("serial-ending") as HTMLSelectElement;
  const sendMode = document.getElementById("serial-mode") as HTMLSelectElement;
  const errorEl = document.getElementById("serial-error") as HTMLDivElement;
  const hintEl = document.getElementById("serial-ports-hint") as HTMLSpanElement;
  const createBtn = document.getElementById("serial-create") as HTMLButtonElement;
  const refreshBtn = document.getElementById("serial-refresh") as HTMLButtonElement;
  const closeBtn = document.getElementById("serial-close") as HTMLButtonElement;
  const cancelBtn = document.getElementById("serial-cancel") as HTMLButtonElement;

  let busy = false;
  let portsToken = 0;

  function setError(text: string) {
    errorEl.textContent = text;
  }

  function isOpen(): boolean {
    return !overlay.hidden;
  }

  function open() {
    if (isOpen()) return;
    setError("");
    overlay.hidden = false;
    void refreshPorts();
    portInput.focus();
    portInput.select();
  }

  function close() {
    if (busy) return; // 正在打开端口：让结果回来再关，避免创建了却没有界面接管
    overlay.hidden = true;
    setError("");
  }

  async function refreshPorts() {
    const token = ++portsToken;
    refreshBtn.disabled = true;
    hintEl.textContent = "正在枚举端口…";
    try {
      const ports = await invoke<SerialPort[]>("serial_ports");
      if (token !== portsToken) return; // 连点刷新：只认最后一次的结果
      portList.textContent = "";
      for (const port of ports) {
        const option = document.createElement("option");
        option.value = port.port;
        option.label = portLabel(port);
        portList.append(option);
      }
      if (!portInput.value && ports.length) {
        // 只填空着的输入框：用户已经手输的端口名不该被列表顶掉
        portInput.value = ports[0].port;
      }
      hintEl.textContent = ports.length
        ? `${ports.length} 个端口 · 也可以手输端口名`
        : "没有枚举到串口 · 可以手输端口名";
    } catch (err) {
      if (token !== portsToken) return;
      hintEl.textContent = "枚举端口失败 · 可以手输端口名";
      console.warn(`[serial] 枚举端口失败: ${String(err)}`);
    } finally {
      if (token === portsToken) refreshBtn.disabled = false;
    }
  }

  function readConfig(): SerialConfig | string {
    const port = portInput.value.trim();
    if (!port) return "先填端口名，例如 COM3";
    const baud = Number.parseInt(baudInput.value, 10);
    if (!Number.isFinite(baud) || baud <= 0) return "波特率必须是正整数";
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
      portInput.focus();
      return;
    }
    busy = true;
    createBtn.disabled = true;
    createBtn.textContent = "连接中…";
    setError("");
    try {
      await deps.create(config);
      busy = false;
      createBtn.disabled = false;
      createBtn.textContent = "创建";
      overlay.hidden = true;
    } catch (err) {
      busy = false;
      createBtn.disabled = false;
      createBtn.textContent = "创建";
      setError(String(err));
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  refreshBtn.addEventListener("click", () => void refreshPorts());
  // 点遮罩空白处关闭；点表单内部不关
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
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

  return { open, close, isOpen };
}
