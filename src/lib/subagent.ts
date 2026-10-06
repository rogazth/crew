/**
 * A harness subagent as its call's row shows it: where it is, what it is on
 * now, and how much it did. Its steps live inside the call's detail, filled
 * by `subagent.event`, so nothing here ever reads as the agent's own work.
 */
import type { Block, SubagentState } from "./blocks";
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

/** "Explore · 12 steps"; the type when there is no count yet. */
export function subagentSuffix(detail: AgentDetail, steps: number): string {
  const kind = detail.agentType || "subagent";
  if (steps === 0) return kind;
  return `${kind} · ${steps} ${steps === 1 ? "step" : "steps"}`;
}

/**
 * A subagent that outlives its turn stands on the rail, out of the turn's
 * fold: it keeps working after the turn that started it ended.
 */
export function isBackgroundSubagent(block: Block, background?: ReadonlySet<string>): boolean {
  const detail = agentDetail(block);
  if (!detail) return false;
  return detail.background === true || (block.tool !== undefined && background?.has(block.tool.callId) === true);
}
