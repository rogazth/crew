import type { SessionStatus } from "./types";

/** Loudest first: a status group only earns the top slot while it needs a human. */
export const STATUS_ORDER: SessionStatus[] = ["needs-input", "error", "working", "idle"];

const LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  working: "Working",
  "needs-input": "Needs input",
  error: "Error",
};

export const statusLabel = (status: SessionStatus): string => LABEL[status];
