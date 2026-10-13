/**
 * What the transcript's orchestration rows say, as text: pure, so the
 * sentences and the fold can be checked without a render.
 */
import type { PanelState } from "./backgroundPanel";
import { tokenCount } from "./contextMeter";
import type { Block, CrewTarget } from "./protocol";
import { agentDetail, type AgentDetail } from "./subagent";
import { duration } from "./time";

/** The first line with words in it. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** A long text folds past this many lines, and shows that many. */
export const FOLD_LINES = 7;

/** Slack of two lines: a text only just over the limit is not worth a fold. */
export function foldsLongText(text: string, lines = FOLD_LINES): boolean {
  return text.split("\n").length > lines + 2;
}

/** What a started agent's card says after its title: tokens, and where it stands. */
export function agentMeta(facts: {
  state: PanelState;
  tokens?: number | undefined;
  activity?: string | null | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
}): string {
  const parts: string[] = [];
  if (facts.tokens !== undefined && facts.tokens > 0) parts.push(`${tokenCount(facts.tokens)} tokens`);
  const took =
    facts.startedAt !== undefined && facts.endedAt !== undefined ? ` after ${duration(Math.max(0, facts.endedAt - facts.startedAt))}` : "";
  switch (facts.state) {
    case "running":
      parts.push(facts.activity?.trim() || "running");
      break;
    case "done":
      parts.push(`done${took}`);
      break;
    case "failed":
      parts.push(`failed${took}`);
      break;
    case "stopped":
      parts.push(`stopped${took}`);
      break;
  }
  return parts.join(" · ");
}

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

/** "Started 3 sessions", with how many did not start when some did not. */
export function startedSessionsSentence(targets: readonly CrewTarget[]): string {
  const failed = targets.filter((target) => target.note).length;
  const made = targets.length - failed;
  const sentence = `Started ${made} ${made === 1 ? "session" : "sessions"}`;
  return failed > 0 ? `${sentence}, ${failed} failed` : sentence;
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
