export interface RuntimeState {
  id: string;
  transport: "terminal" | "serial";
  paused: boolean;
  serial: unknown | null;
}

export interface RuntimeStateCache {
  paused: ReadonlyMap<string, boolean>;
  serial: ReadonlyMap<string, unknown>;
}

/** Merge one backend snapshot while preserving local state changed after the request started. */
export function mergeRuntimeStates(
  previous: RuntimeStateCache,
  states: readonly RuntimeState[],
  revisionsAtRequest: ReadonlyMap<string, number>,
  currentRevisions: ReadonlyMap<string, number>,
  liveIds: ReadonlySet<string>
): RuntimeStateCache {
  const paused = new Map([...previous.paused].filter(([id]) => liveIds.has(id)));
  const serial = new Map([...previous.serial].filter(([id]) => liveIds.has(id)));
  for (const state of states) {
    if (state.transport === "serial") {
      if (state.serial !== null) serial.set(state.id, state.serial);
      continue;
    }
    if ((currentRevisions.get(state.id) ?? 0) === (revisionsAtRequest.get(state.id) ?? 0)) {
      paused.set(state.id, state.paused);
    }
  }
  return { paused, serial };
}
