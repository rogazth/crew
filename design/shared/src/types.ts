/**
 * Mirrors `src/lib/protocol.ts` and `src/lib/types.ts` of the real renderer.
 * Kept as a standalone copy so the prototypes never import from the app.
 */

export type AgentRef = { id: string; name: string };

export type AttachedFileKind = "image" | "file";
export type AttachedFile = { name: string; path: string; kind?: AttachedFileKind; size?: number };

export type ApprovalDecision = "allow" | "always" | "deny";
export type ToolStatus = "pending" | "completed" | "failed" | "interrupted";

export type ToolDetail =
  | { kind: "command"; command: string; exitCode?: number; output?: string }
  | { kind: "file"; path: string; lineStart?: number; lineEnd?: number; preview?: string }
  | { kind: "edit"; path: string; added?: number; removed?: number; diff?: string }
  | { kind: "search"; query: string; matches?: number }
  | { kind: "fetch"; url: string; title?: string }
  | { kind: "message"; to: string; text: string }
  | { kind: "output"; text: string };

export type BlockRole =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "approval"
  | "question"
  | "system";

export type QuestionOption = { label: string; description?: string };
export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

export type TurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  at?: number;
  hidden?: boolean;
  streaming?: boolean;
  files?: AttachedFile[];
  tool?: {
    callId: string;
    name: string;
    title: string;
    status: ToolStatus;
    detail?: ToolDetail;
    /**
     * The call's raw arguments. The daemon does not send these today; they are
     * what lets Crew's own tools (`create_agent`, `upsert_routine`, …) produce a
     * readable row without a `ToolDetail` of their own. See `crewTools.ts`.
     */
    args?: Record<string, unknown>;
  };
  approval?: {
    requestId: number;
    name: string;
    input?: Record<string, unknown>;
    decided?: ApprovalDecision;
  };
  question?: {
    requestId: number;
    questions: Question[];
    answers?: Record<string, string>;
    dismissed?: boolean;
  };
  usage?: TurnUsage;
  /** Set when another agent wrote this line instead of the user. */
  fromAgent?: AgentRef;
};

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.note"; message: string }
  | { type: "user.message"; text: string; hidden?: boolean; files?: AttachedFile[]; fromAgent?: AgentRef }
  | { type: "system.message"; text: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | { type: "reasoning.delta"; text: string }
  | { type: "turn.completed"; usage?: TurnUsage }
  | { type: "tool.started"; callId: string; name: string; title: string; detail?: ToolDetail }
  | { type: "tool.updated"; callId: string; title?: string; status?: ToolStatus; detail?: ToolDetail }
  | { type: "approval.requested"; requestId: number; name: string; title: string; input?: Record<string, unknown> }
  | { type: "approval.resolved"; requestId: number; decision: ApprovalDecision | "cancelled" }
  | { type: "question.requested"; requestId: number; questions: Question[] }
  | { type: "question.resolved"; requestId: number; answers: Record<string, string> | null };

export type Workspace = { id: string; name: string; path: string; createdAt: number };

export type SessionKind = "agent" | "terminal";
export type SessionStatus = "idle" | "working" | "needs-input" | "done" | "error";
export type Autonomy = "ask" | "full";

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
  autonomy: Autonomy;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** Which agent spawned this one. A first-class field, not a patch. */
  createdBy?: AgentRef | null;
};

export type ProjectFile = { name: string; path: string; relative: string };

export const STUB_KINDS = ["terminal", "browser", "sidechat"] as const;
export type StubKind = (typeof STUB_KINDS)[number];

export type Tab =
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "file"; path: string; relative: string }
  | { id: string; kind: "stub"; stub: StubKind; title: string };

export type SearchHit = {
  sessionId: string;
  sessionName: string;
  pos: number;
  id: string;
  role: BlockRole;
  at: number;
  /** Matches are wrapped in  … . */
  snippet: string;
};

export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] }
  | { kind: "cron"; expression: string };

export type RunStatus = "running" | "ok" | "error" | "skipped";

export type RoutineRun = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  trigger: "schedule" | "manual";
};

export type Routine = {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runs: RoutineRun[];
  createdBy: AgentRef | null;
};

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "terminal"
  | "providers"
  | "keybindings"
  | "about";

/** What a live thread looks like at any moment, whatever is driving it. */
export type ThreadState = {
  blocks: Block[];
  working: boolean;
  status: SessionStatus;
  /** Older blocks exist before the first one held. */
  more?: boolean;
};
