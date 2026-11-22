import { describe, expect, it } from "vitest";
import { portLabel, type SerialPort } from "./sessionDialogUi";

function port(over: Partial<SerialPort>): SerialPort {
  return {
    port: "COM3",
    kind: "unknown",
    vid: null,
    pid: null,
    manufacturer: null,
    product: null,
    serial_number: null,
    ...over
  };
}

describe("端口下拉的文案（portLabel）", () => {
  it("优先用产品名，其次是厂商名，最后退到通道类型", () => {
    expect(portLabel(port({ product: "USB-SERIAL CH340", manufacturer: "wch.cn" }))).toBe(
      "COM3 · USB-SERIAL CH340"
    );
    expect(portLabel(port({ manufacturer: "wch.cn" }))).toBe("COM3 · wch.cn");
    expect(portLabel(port({ kind: "bluetooth" }))).toBe("COM3 · 蓝牙");
  });

  it("优先使用设备管理器友好名，而不是 Unknown 分类或产品名", () => {
    expect(portLabel(port({
      kind: "unknown",
      product: "USB Serial",
      friendly_name: "USB-SERIAL CH340 (COM3)"
    }))).toBe("COM3 · USB-SERIAL CH340 (COM3)");
  });

  it("假串口带自己的标签，不与真设备混淆", () => {
    const fake = port({ port: "PINSHELL_LOOP", kind: "virtual", product: "假串口（回环，仅调试）" });
    expect(portLabel(fake)).toBe("PINSHELL_LOOP · 假串口（回环，仅调试）");
  });

  it("空字符串的详情也当没有，不会画出「COM3 · 」这种半截文案", () => {
    expect(portLabel(port({ product: "", manufacturer: "" }))).toBe("COM3 · 串口设备");
  });
});
