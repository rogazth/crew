/**
 * What the transcript's orchestration rows say, as text: pure, so the
 * sentences and the fold can be checked without a render.
 */
import type { Block, CrewTarget } from "./protocol";
import { agentDetail, type AgentDetail } from "./subagent";

/** A long text folds past this many lines, and shows that many. */
export const FOLD_LINES = 7;

/** What a Crew call started. */
export type Started =
  | { kind: "subagent"; target: CrewTarget; prompt: string }
  | { kind: "session"; target: CrewTarget; prompt: string }
  | { kind: "sessions"; targets: CrewTarget[] };

/**
 * A Crew call that started something: `delegate` (a Crew subagent),
 * `start_session` (an independent session), `start_sessions` (several). A
 * handoff to the user is a letter, not a start; a refused call is a refusal.
 */
export function startedOf(block: Block): Started | null {
  if (block.role !== "tool") return null;
  const detail = block.tool?.detail;
  if (detail?.kind === "message" && !detail.error && (detail.what === "start" || detail.what === "launch")) {
    const target: CrewTarget = { name: detail.toName ?? detail.to, ...(detail.toId ? { id: detail.toId } : {}) };
    return { kind: detail.what === "start" ? "subagent" : "session", target, prompt: detail.text };
  }
  if (detail?.kind === "crew" && detail.verb === "start_sessions") return { kind: "sessions", targets: detail.targets };
  return null;
}

/** The name Crew gives a session whose call named none: its CLI and the prompt's first words. */
export function defaultSessionName(provider: string, prompt: string): string {
  const name = `${provider}: ${prompt.split(/\s+/).filter(Boolean).slice(0, 6).join(" ")}`;
  return [...name].length > 48 ? `${[...name].slice(0, 47).join("")}…` : name;
}

/** What a session row has to say for a start call to find it. */
type StartedRowOf = { id: string; name: string; provider: string; createdAt: number; parentId?: string; launchedBy?: string };

/**
 * The session a start call made, before its answer names it: a `delegate`
 * that waits answers only once the child is done, and the child's row is
 * there from its first second. The owner's child or launched session, made
 * after the call, under the name it asked for or the one Crew gives.
 */
export function startedSession<T extends StartedRowOf>(
  sessions: readonly T[],
  ownerId: string | undefined,
  block: Block,
  started: Extract<Started, { kind: "subagent" | "session" }>,
): T | undefined {
  if (!ownerId || started.target.id) return undefined;
  // The call's time and the row's come from the same clock; a little slack for the order they were written in.
  const since = (block.at ?? 0) - 2_000;
  const mine = (row: T) => (started.kind === "subagent" ? row.parentId === ownerId : row.launchedBy === ownerId);
  const named = (row: T) => row.name === started.target.name || row.name === defaultSessionName(row.provider, started.prompt);
  return sessions
    .filter((row) => mine(row) && row.createdAt >= since && named(row))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/** The name a native subagent goes by in a row: its type, else what it was for. */
export function nativeName(detail: AgentDetail): string {
  return detail.agentType?.trim() || detail.description.trim() || "subagent";
}

/** A native subagent call's report, once it has one: the call's output. */
export function nativeReport(block: Block): string | null {
  const text = agentDetail(block)?.output?.trim();
  return text ? text : null;
}

/**
 * When a native subagent's report landed. The call block is where the agent was
 * started, so its own time would pin every report to the start; its last step is
 * the closest the transcript gets to the moment it answered. A call with no
 * steps keeps its own time, and the report stays under its card.
 */
export function nativeReportAt(block: Block): number | undefined {
  const detail = agentDetail(block);
  if (!detail?.output?.trim()) return undefined;
  const steps = detail.steps ?? [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const at = steps[index]?.at;
    if (at !== undefined) return at;
  }
  return block.at;
}

/** A letter's words without the daemon's "It exited (why)." lead: the model reads it, the transcript does not. */
export function exitedless(block: Block): string {
  return block.letterKind === "report" ? block.text.replace(/^It exited \([^)\n]*\)\.\s*/, "") : block.text;
}

/** A report letter: what a Crew subagent's last turn sent its parent. */
export function isReportLetter(block: Block): boolean {
  return block.role === "user" && block.fromBot !== undefined && block.letterId !== undefined && block.letterKind === "report";
}

/** The system line a start leaves ("Delegated to subagent X (id)"): the start's row already says it. */
const START_NOTE = /^(?:Started session|Delegated to subagent) .+ \(([^()]+)\)$/;

/** The id a start's note names, for dropping it once the call's own row shows the same start. */
export function startNoteTarget(block: Block): string | null {
  if (block.role !== "system") return null;
  return START_NOTE.exec(block.text)?.[1] ?? null;
}

/** The icon a control row wears, by what it did. */
export type ControlIcon = "interrupt" | "read" | "list" | "stop" | "rename" | "delete";

/**
 * A control call as one line: `before`, the session it acted on, `after`.
 * `text` is what it carried when that is worth a card (an interrupt's redirect).
 */
export type Control = { icon: ControlIcon; before: string; target?: CrewTarget; after: string; text?: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What `interrupt_session`, `read_session`, `list_peers`, `stop_session` and
 * `update_session` say in a transcript. Null for any other block, and for a
 * call that failed: that one keeps the generic failed row with its error.
 */
export function controlOf(block: Block): Control | null {
  if (block.role !== "tool" || block.tool?.status === "failed") return null;
  const detail = block.tool?.detail;
  if (detail?.kind !== "crew") return null;
  const target = detail.targets[0];
  const at = target ? { target } : {};
  switch (detail.verb) {
    case "interrupt_session": {
      const text = detail.text?.trim();
      if (text) return { icon: "interrupt", before: "Interrupted", ...at, after: " and redirected it", text };
      return { icon: "interrupt", before: "Interrupted", ...at, after: detail.note === "idle" ? " · it was idle" : "" };
    }
    case "read_session": {
      const n = detail.count;
      const after = n === undefined ? "'s messages" : n === 1 ? "'s last message" : `'s last ${n} messages`;
      return { icon: "read", before: "Read", ...at, after };
    }
    case "list_peers": {
      const peers = detail.count === undefined ? "peers" : plural(detail.count, "peer");
      return { icon: "list", before: `Listed ${peers}${detail.note ? ` · ${detail.note}` : ""}`, after: "" };
    }
    case "stop_session":
      return { icon: "stop", before: "Stopped", ...at, after: detail.count ? ` and its ${plural(detail.count, "subagent")}` : "" };
    case "update_session":
      if (detail.note === "rename") return { icon: "rename", before: "Renamed", ...at, after: detail.text ? ` to ${detail.text}` : "" };
      if (detail.note === "effort") return { icon: "rename", before: "Set the effort of", ...at, after: detail.text ? ` to ${detail.text}` : "" };
      if (detail.note === "delete") {
        const also = detail.count ? ` and its ${plural(detail.count, "subagent")}` : "";
        return { icon: "delete", before: "Deleted", ...at, after: `${also} · its worktree stays` };
      }
      return null;
    default:
      return null;
  }
}

/** How a send went over, as the muted suffix on its row; null when the answer did not say. */
export function deliveryNote(delivery: string | undefined): string | null {
  switch (delivery) {
    case "started":
      return "started a turn";
    case "queued":
      return "queued";
    case "steered":
      return "read mid-turn";
    case "answered":
      return "answered its question";
    default:
      return null;
  }
}

/** A message out: whom, the words, the letter it made, how it was delivered. */
export type Sent = { to: CrewTarget; text: string; letterId?: string; delivery: string | null; handoff: boolean };

/** A `send_message` that went (a refused one is a refusal; a start is a start). */
export function sentOf(block: Block): Sent | null {
  if (block.role !== "tool") return null;
  const detail = block.tool?.detail;
  if (detail?.kind !== "message" || detail.error) return null;
  if (detail.what === "start" || detail.what === "launch") return null;
  const to: CrewTarget = { name: detail.toName ?? detail.to, ...(detail.toId ? { id: detail.toId } : {}) };
  return {
    to,
    text: detail.text,
    ...(detail.letterId ? { letterId: detail.letterId } : {}),
    delivery: deliveryNote(detail.delivery),
    handoff: detail.what === "handoff",
  };
}

