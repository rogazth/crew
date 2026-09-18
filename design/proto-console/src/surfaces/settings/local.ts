import { useSyncExternalStore } from "react";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@crew/fixtures";

/** Named colour schemes an agent mark can draw from. Presentational only. */
export type AgentTheme = "auto" | "provider" | "identity" | "none";

/**
 * Preferences the daemon has nowhere to keep yet. They live in this window so
 * the controls are real, and every row that uses one says so in its description.
 */
export type LocalPrefs = {
  defaultProvider: string;
  defaultModel: string;
  reopenWorkspace: boolean;
  confirmLiveClose: boolean;
  telemetry: boolean;
  agentTheme: AgentTheme;
};

let prefs: LocalPrefs = {
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
  reopenWorkspace: true,
  confirmLiveClose: true,
  telemetry: false,
  agentTheme: "auto",
};

const listeners = new Set<() => void>();
const read = () => prefs;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setLocal(patch: Partial<LocalPrefs>): void {
  prefs = { ...prefs, ...patch };
  for (const listener of listeners) listener();
}

export function useLocal(): LocalPrefs {
  return useSyncExternalStore(subscribe, read, read);
}
