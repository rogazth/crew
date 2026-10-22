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

/**
 * A question letter's words without the options the daemon lists under each
 * question ("   Options: Red; Blue"): the model reads them to answer, while the
 * chat shows the child's options as buttons under the letter.
 */
export function optionless(text: string): string {
  return text.replace(/\n[ \t]+Options(?: \([^)\n]*\))?: [^\n]*/g, "");
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

/** What a letter from another party says it is, by the kind its mailbox gave it. */
export function envelopeOf(kind: string | undefined): { word: string; tag?: string } {
  switch (kind) {
    case "question":
    case "approval":
      return { word: "asks", tag: "waits on an answer" };
    case "started":
      return { word: "started this session" };
    default:
      return { word: "wrote" };
  }
}

/**
 * The child's own card a question or approval letter is about: the newest one
 * of that kind whose words the letter carries (the letter is made from the
 * request's text, so an older letter never claims a newer request).
 */
export function askOf(blocks: readonly Block[], kind: "question" | "approval", letterText: string): Block | null {
  for (let at = blocks.length - 1; at >= 0; at--) {
    const block = blocks[at]!;
    if (block.role !== kind) continue;
    const words = kind === "question" ? (block.question?.questions.map((one) => one.question) ?? []) : [block.text];
    if (words.some((word) => word && letterText.includes(word))) return block;
  }
  return null;
}

/** A question the parent's chat answers with one click: one single-choice question with a few options. */
export function isQuickQuestion(block: Block): boolean {
  const questions = block.question?.questions ?? [];
  const only = questions[0];
  return questions.length === 1 && !!only && !only.multiSelect && only.options.length > 0 && only.options.length <= 4;
}
