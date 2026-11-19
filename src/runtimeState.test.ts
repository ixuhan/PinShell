import { describe, expect, it } from "vitest";
import { mergeRuntimeStates, type RuntimeStateCache } from "./runtimeState";

const previous: RuntimeStateCache = {
  paused: new Map([["terminal", true], ["gone", false]]),
  serial: new Map([["serial", { status: "failed" }], ["gone", { status: "open" }]])
};

describe("mergeRuntimeStates", () => {
  it("prunes closed sessions and merges terminal and serial snapshots", () => {
    const merged = mergeRuntimeStates(
      previous,
      [
        { id: "terminal", transport: "terminal", paused: false, serial: null },
        { id: "serial", transport: "serial", paused: false, serial: { status: "open" } }
      ],
      new Map(),
      new Map(),
      new Set(["terminal", "serial"])
    );
    expect([...merged.paused]).toEqual([["terminal", false]]);
    expect([...merged.serial]).toEqual([["serial", { status: "open" }]]);
  });

  it("does not overwrite terminal state changed after the snapshot request", () => {
    const merged = mergeRuntimeStates(
      previous,
      [{ id: "terminal", transport: "terminal", paused: false, serial: null }],
      new Map([["terminal", 4]]),
      new Map([["terminal", 5]]),
      new Set(["terminal"])
    );
    expect(merged.paused.get("terminal")).toBe(true);
  });
});
