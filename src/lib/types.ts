export type Workspace = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
};

export type SessionKind = "agent" | "terminal";

/** Written by whatever runs the session: the terminal today, the agent runtime later. */
export type SessionStatus = "idle" | "working" | "needs-input" | "done" | "error";

export type Session = {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  name: string;
  provider: string;
  model: string;
  providerSessionId: string | null;
  description: string;
  notifications: boolean;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
};

export type ProjectFile = {
  name: string;
  path: string;
  relative: string;
};

/** Surfaces that have chrome but no runtime yet. One tab kind covers them all. */
export const STUB_KINDS = ["terminal", "browser", "sidechat"] as const;

export type StubKind = (typeof STUB_KINDS)[number];

export type Tab =
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "file"; path: string; relative: string }
  | { id: string; kind: "stub"; stub: StubKind; title: string };
