import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortPolling, pollDelay, samePorts } from "./serialPortsPanel";
import type { SerialPort } from "./serialUi";

const port: SerialPort = {
  port: "COM3", kind: "usb", vid: 1, pid: 2,
  manufacturer: "Maker", product: "USB Serial", serial_number: "123"
};

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let visible = true;
  const read = vi.fn<() => Promise<SerialPort[]>>().mockResolvedValue([port]);
  const result = vi.fn();
  const error = vi.fn();
  const polling = createPortPolling({ read, result, error, canAuto: () => visible });
  return { read, result, error, polling, hide: () => { visible = false; }, show: () => { visible = true; } };
}

describe("serial port snapshots", () => {
  it("compares all metadata and handles empty lists", () => {
    expect(samePorts(null, [])).toBe(false);
    expect(samePorts([], [])).toBe(true);
    expect(samePorts([port], [{ ...port }])).toBe(true);
    for (const [key, value] of Object.entries(port)) {
      const changed = { ...port, [key]: typeof value === "number" ? value + 1 : `${value}-changed` };
      expect(samePorts([port], [changed as SerialPort])).toBe(false);
    }
    expect(samePorts([port], [])).toBe(false);
  });

  it("uses the file panel's three-step exponential backoff with a 1 second base", () => {
    expect([0, 1, 2, 3, 9].map(pollDelay)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});

describe("serial port polling", () => {
  it("starts off and performs only one manual scan by default", async () => {
    const f = fixture();
    await f.polling.refresh();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("scans immediately on enable, then waits one second after completion", async () => {
    const f = fixture();
    f.polling.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.polling.setAuto(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("coalesces slow requests including manual refresh", async () => {
    const f = fixture();
    let resolve!: (ports: SerialPort[]) => void;
    f.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.polling.setAuto(true);
    await vi.advanceTimersByTimeAsync(5000);
    const pending = f.polling.refresh();
    expect(f.read).toHaveBeenCalledTimes(1);
    resolve([port]);
    await pending;
    await vi.advanceTimersByTimeAsync(999);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and resumes the timer without an immediate scan", async () => {
    const f = fixture();
    f.polling.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    f.hide();
    f.polling.sync();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.show();
    f.polling.sync();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("does not resume after an in-flight request completes while hidden", async () => {
    const f = fixture();
    let resolve!: (ports: SerialPort[]) => void;
    f.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.polling.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    f.hide();
    f.polling.sync();
    resolve([port]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("backs off after failures and resets after success or manual refresh", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("unavailable")).mockRejectedValueOnce(new Error("unavailable"));
    f.polling.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledTimes(4);
    f.read.mockRejectedValueOnce(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    await f.polling.refresh();
    expect(f.read).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledTimes(7);
  });
});
