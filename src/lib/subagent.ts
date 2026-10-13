/**
 * A harness subagent as its call's row shows it: where it is, what it is on
 * now, and how much it did. Its steps live inside the call's detail, filled
 * by `subagent.event`, so nothing here ever reads as the agent's own work.
 */
import type { Block, SubagentState } from "./blocks";
import type { PanelEntry } from "./backgroundPanel";
import { summarize } from "./activity";
import { detailOf, prettyTitle, type ToolDetail } from "./toolDetail";

export type AgentDetail = Extract<ToolDetail, { kind: "agent" }>;

export type SubagentView = {
  state: SubagentState;
  /** What it is on now, while it runs: "Reading transcriptRows.ts". */
  current: string | null;
  /** Its calls so far. */
  steps: number;
  background: boolean;
};

export function agentDetail(block: Block): AgentDetail | null {
  const detail = detailOf(block);
  return block.role === "tool" && detail?.kind === "agent" ? detail : null;
}

/**
 * Where it is. The CLI says so when Crew follows it live; otherwise the call
 * stands for it, except a background one, whose call returns at once and
 * whose end is its report.
 */
export function subagentState(block: Block, detail: AgentDetail): SubagentState {
  if (detail.state) return detail.state;
  switch (block.tool?.status) {
    case "pending":
      return "running";
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return detail.background && !detail.output ? "running" : "done";
  }
}

export function subagentView(block: Block): SubagentView | null {
  const detail = agentDetail(block);
  if (!detail) return null;
  const state = subagentState(block, detail);
  const steps = detail.steps ?? [];
  return {
    state,
    current: state === "running" ? (detail.activity?.trim() || currentStep(steps)) : null,
    steps: steps.filter((step) => step.role === "tool").length,
    background: detail.background === true,
  };
}

/** The newest step, as one line in the present tense. */
export function currentStep(steps: Block[]): string | null {
  const last = steps.at(-1);
  if (!last) return null;
  if (last.role === "assistant" || last.role === "reasoning") return summarize(last.text) || null;
  if (last.role !== "tool") return null;
  const detail = detailOf(last);
  switch (detail?.kind) {
    case "file":
      return `Reading ${leaf(detail.path)}`;
    case "edit":
      return `Editing ${leaf(detail.path)}`;
    case "command":
      return `Running ${summarize(detail.command, 72)}`;
    case "search":
      return `Searching ${summarize(detail.query, 60)}`;
    case "fetch":
      return `Fetching ${detail.url}`;
    default:
      return prettyTitle(last.tool?.title ?? last.text) || null;
  }
}

function leaf(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * The steps the opened row lists. Its last words are usually its report,
 * which the row shows under them anyway: once is enough.
 */
export function shownSteps(detail: AgentDetail): Block[] {
  const steps = detail.steps ?? [];
  const last = steps.at(-1);
  const report = detail.output?.trim();
  if (!report || last?.role !== "assistant") return steps;
  const said = last.text.trim();
  // A step keeps less of it than the row does: the start says whether it is the same text.
  const same = said.length > 0 && report.startsWith(said.slice(0, 400));
  return same ? steps.slice(0, -1) : steps;
}

/**
 * The work-list entry a native subagent's call stands for: the one the call
 * started, or the one its session already had when the call continues it.
 */
export function entryOfCall(entries: readonly PanelEntry[], block: Block): PanelEntry | undefined {
  const callId = block.tool?.callId;
  const byCall = callId ? entries.find((one) => one.callId === callId) : undefined;
  if (byCall) return byCall;
  const thread = agentDetail(block)?.thread;
  return thread ? entries.find((one) => one.source.type === "command" && one.source.id === thread) : undefined;
}

/** Whether a call goes on with a subagent an earlier call started, rather than starting one. */
export function resumesEntry(entry: PanelEntry | undefined, block: Block): boolean {
  return entry?.callId !== undefined && block.tool?.callId !== undefined && entry.callId !== block.tool.callId;
}

/** Every call of the transcript that is this entry's, oldest first: its first call, then the ones that continued it. */
export function callsOfEntry(blocks: readonly Block[], entry: PanelEntry): Block[] {
  return blocks.filter((block) => {
    const detail = agentDetail(block);
    if (!detail) return false;
    return block.tool?.callId === entry.callId || (entry.source.type === "command" && detail.thread === entry.source.id);
  });
}

const STATE_NOTE: Partial<Record<SubagentState, string>> = {
  done: "Nothing came back.",
  failed: "It failed before reporting back.",
  stopped: "Stopped before reporting back.",
};

/**
 * A subagent's thread as the chat's own blocks, so it draws like any chat:
 * for each call what it was asked, the child's steps, and what it answered.
 * A call that continued the child adds its turn after the first. The blocks
 * carry no time, so the thread shows no date lines of its own.
 */
export function threadBlocks(calls: readonly Block[]): Block[] {
  const blocks: Block[] = [];
  for (const call of calls) {
    const detail = agentDetail(call);
    if (!detail) continue;
    if (detail.prompt?.trim()) blocks.push({ id: `${call.id}:asked`, role: "user", text: detail.prompt });
    blocks.push(...shownSteps(detail));
    const state = subagentState(call, detail);
    const note = STATE_NOTE[state];
    if (detail.output?.trim()) blocks.push({ id: `${call.id}:report`, role: "assistant", text: detail.output });
    else if (state !== "running" && note) blocks.push({ id: `${call.id}:note`, role: "system", text: note });
  }
  return blocks;
}

/** "Explore · 12 steps"; the type when there is no count yet. */
export function subagentSuffix(detail: AgentDetail, steps: number): string {
  const kind = detail.agentType || "subagent";
  if (steps === 0) return kind;
  return `${kind} · ${steps} ${steps === 1 ? "step" : "steps"}`;
}
