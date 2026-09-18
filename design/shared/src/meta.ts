import type { SessionStatus, SettingsSectionId } from "./types";

export const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "providers", label: "Providers" },
  { id: "keybindings", label: "Keybindings" },
  { id: "about", label: "About" },
];

export const SETTINGS_DEFAULT: SettingsSectionId = "general";

/** Loudest first: a status group only earns the top slot while it needs a human. */
export const STATUS_ORDER: SessionStatus[] = ["needs-input", "error", "working", "done", "idle"];

const LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  working: "Working",
  "needs-input": "Needs input",
  done: "Unread",
  error: "Error",
};

export const statusLabel = (status: SessionStatus): string => LABEL[status];

export const STUB_LABELS: Record<string, string> = {
  terminal: "Terminal",
  browser: "Browser",
  sidechat: "Side chat",
};
