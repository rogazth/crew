import type { AgentRef, Block, TurnUsage } from "./types";
import { detailOf, isOpen } from "./toolDetail";

// ---------------------------------------------------------------------------
// Phases — a run of tool calls of one kind
// ---------------------------------------------------------------------------

export type PhaseKind = "edit" | "research" | "run" | "other";
export type Phase = { id: string; kind: PhaseKind; blocks: Block[] };

const EDIT = /^(edit|multiedit|write|notebookedit|apply_patch)$/i;
const RUN = /^(bash|shell|command|terminal|exec_command)$/i;
const RESEARCH = /^(read|notebookread|glob|grep|ls|websearch|webfetch|search|find|list|read_file)$/i;

export function kindOf(name: string): PhaseKind {
  if (EDIT.test(name)) return "edit";
  if (RUN.test(name)) return "run";
  if (RESEARCH.test(name) || /search|fetch|read/i.test(name)) return "research";
  return "other";
}

export function phaseKind(block: Block): PhaseKind {
  const detail = detailOf(block);
  switch (detail?.kind) {
    case "command":
      return "run";
    case "edit":
      return "edit";
    case "file":
    case "search":
    case "fetch":
      return "research";
    case "message":
    case "output":
      return "other";
    default:
      return kindOf(block.tool?.name ?? block.approval?.name ?? "");
  }
}

export type ActivityItem =
  | { kind: "phase"; phase: Phase }
  | { kind: "reasoning"; block: Block }
  | { kind: "question"; block: Block };

export function buildActivity(blocks: Block[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  let phase: Phase | null = null;
  for (const block of blocks) {
    if (block.role === "reasoning") {
      phase = null;
      items.push({ kind: "reasoning", block });
      continue;
    }
    if (block.role === "question") {
      phase = null;
      items.push({ kind: "question", block });
      continue;
    }
    const kind = phaseKind(block);
    if (phase && phase.kind === kind) {
      phase.blocks.push(block);
      continue;
    }
    phase = { id: block.id, kind, blocks: [block] };
    items.push({ kind: "phase", phase });
  }
  return items;
}

export const phaseOpen = (phase: Phase) => phase.blocks.some(isOpen);
export const phaseFailed = (phase: Phase) => phase.blocks.some((b) => b.tool?.status === "failed");

function targetOf(block: Block): string | null {
  const detail = detailOf(block);
  if (detail?.kind === "file" || detail?.kind === "edit") return detail.path.split("/").pop() ?? detail.path;
  if (detail) return null;
  const match = /^(?:Read|Edit|Write|Glob|Grep|Search|Fetch|List)\s+(.+)$/.exec(block.tool?.title ?? block.text);
  return match?.[1]?.split("/").pop() ?? null;
}

function isSearch(block: Block): boolean {
  const detail = detailOf(block);
  if (detail) return detail.kind === "search" || detail.kind === "fetch";
  return /^(glob|grep|websearch|search|find)$/i.test(block.tool?.name ?? "");
}

const fileLabel = (files: Set<string>) => (files.size === 1 ? [...files][0]! : `${files.size} files`);

/** One line for a folded phase. Present tense while open, past once settled. */
export function phaseLabel(phase: Phase): string {
  const live = phaseOpen(phase);
  const files = new Set<string>();
  let searches = 0;
  for (const block of phase.blocks) {
    const target = targetOf(block);
    if (isSearch(block)) searches += 1;
    else if (target) files.add(target);
  }
  const count = phase.blocks.length;
  switch (phase.kind) {
    case "edit":
      return files.size > 0
        ? `${live ? "Editing" : "Edited"} ${fileLabel(files)}`
        : live
          ? "Editing"
          : "Edited";
    case "research":
      if (files.size > 0 && searches === 0) return `${live ? "Reading" : "Read"} ${fileLabel(files)}`;
      if (files.size === 0) return live ? "Searching the project" : "Searched the project";
      return live ? "Exploring the project" : "Explored the project";
    case "run":
      if (count === 1) return live ? "Running a command" : "Ran a command";
      return `${live ? "Running" : "Ran"} ${count} commands`;
    default:
      if (count === 1) return phase.blocks[0]!.tool?.title ?? phase.blocks[0]!.text;
      return `${live ? "Running" : "Ran"} ${count} tools`;
  }
}

/** How many rows a run reaches before it folds behind one line. */
export const FOLD_AT = 3;

export type ActivityDigest = { label: string; kind: PhaseKind | "thought" };

export function activityDigest(items: ActivityItem[]): ActivityDigest {
  const byKind = new Map<PhaseKind, Block[]>();
  let thoughts = 0;
  for (const item of items) {
    if (item.kind === "reasoning") {
      thoughts += 1;
      continue;
    }
    if (item.kind === "question") continue;
    const held = byKind.get(item.phase.kind);
    if (held) held.push(...item.phase.blocks);
    else byKind.set(item.phase.kind, [...item.phase.blocks]);
  }
  if (byKind.size === 0) {
    return { kind: "thought", label: thoughts === 1 ? "Thought" : `Thought ${thoughts} times` };
  }
  const ranked = [...byKind]
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 2)
    .map(([kind, blocks]) => ({ kind, label: phaseLabel({ id: blocks[0]!.id, kind, blocks }) }));
  const [first, second] = ranked;
  return {
    kind: first!.kind,
    label: second ? `${first!.label}, ${decap(second.label)}` : first!.label,
  };
}

const decap = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** The first line of a thought, markdown noise stripped. */
export function summarize(text: string, max = 96): string {
  const line =
    text
      .split("\n")
      .map((row) => row.replace(/^[#>\-*\s]+/, "").replace(/[*_`]/g, "").trim())
      .find((row) => row.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Rows — what the transcript actually paints
// ---------------------------------------------------------------------------

/** A gap this long between messages gets a date line. */
export const DATE_BREAK_MS = 30 * 60_000;

const ACTIVITY_ROLES = new Set(["tool", "approval", "question", "reasoning"]);

/**
 * A run of consecutive letters from other agents, in either direction.
 * Inbound is `fromAgent`; outbound is a `message` tool detail. Both halves
 * belong to the same conversation, so they group together.
 */
export type AgentMessage = {
  block: Block;
  direction: "in" | "out";
  /** The other side of the exchange. */
  peer: AgentRef;
};

export type Row =
  | { kind: "message"; block: Block }
  | { kind: "activity"; id: string; blocks: Block[] }
  | { kind: "agent-thread"; id: string; messages: AgentMessage[]; peers: AgentRef[] }
  | { kind: "footer"; id: string; usage: TurnUsage; at?: number }
  | { kind: "date"; id: string; at: number };

export type Speaker = "user" | "agent" | "meta";

export function speaker(row: Row): Speaker {
  if (row.kind === "activity" || row.kind === "footer") return "agent";
  if (row.kind === "date" || row.kind === "agent-thread") return "meta";
  if (row.block.role === "user") return row.block.fromAgent ? "meta" : "user";
  if (row.block.role === "system") return "meta";
  return "agent";
}

function agentMessageOf(block: Block, resolve: (id: string) => string): AgentMessage | null {
  if (block.fromAgent) return { block, direction: "in", peer: block.fromAgent };
  const detail = detailOf(block);
  if (detail?.kind === "message") {
    return { block, direction: "out", peer: { id: detail.to, name: resolve(detail.to) } };
  }
  return null;
}

/** "2 messages with Relay" · "3 messages with 2 agents". */
export function agentThreadLabel(row: Extract<Row, { kind: "agent-thread" }>): string {
  const count = row.messages.length;
  const noun = count === 1 ? "message" : "messages";
  if (row.peers.length === 1) return `${count} ${noun} with ${row.peers[0]!.name}`;
  return `${count} ${noun} with ${row.peers.length} agents`;
}

export type GroupOptions = {
  /** Turns an agent id into its display name. */
  resolveAgent?: (id: string) => string;
  /** false renders agent letters as ordinary rows instead of grouping them. */
  groupAgentMessages?: boolean;
};

export function groupRows(blocks: Block[], options: GroupOptions = {}): Row[] {
  const resolve = options.resolveAgent ?? ((id: string) => id);
  const grouping = options.groupAgentMessages ?? true;
  const rows: Row[] = [];
  let activity: Block[] = [];
  let letters: AgentMessage[] = [];
  let lastAt: number | undefined;
  let activityFooter: Row | null = null;

  const flushLetters = () => {
    if (letters.length === 0) return;
    const peers: AgentRef[] = [];
    for (const letter of letters) {
      if (!peers.some((p) => p.id === letter.peer.id)) peers.push(letter.peer);
    }
    rows.push({ kind: "agent-thread", id: letters[0]!.block.id, messages: letters, peers });
    letters = [];
  };

  const flushActivity = () => {
    if (activity.length === 0) return;
    rows.push({ kind: "activity", id: activity[0]!.id, blocks: activity });
    activity = [];
    if (activityFooter) {
      rows.push(activityFooter);
      activityFooter = null;
    }
  };

  for (const block of blocks) {
    if (block.hidden) continue;

    const letter = grouping ? agentMessageOf(block, resolve) : null;
    if (letter) {
      // A letter interrupts both a tool run and the prose around it.
      flushActivity();
      letters.push(letter);
      if (block.usage) activityFooter = footerFor(block, block.usage);
      continue;
    }
    flushLetters();

    if (ACTIVITY_ROLES.has(block.role)) {
      activity.push(block);
      if (block.usage) activityFooter = footerFor(block, block.usage);
      continue;
    }
    if (block.role === "assistant" && !block.text && block.streaming) continue;

    flushActivity();
    if (block.role === "user" && block.at !== undefined) {
      if (lastAt === undefined || block.at - lastAt > DATE_BREAK_MS) {
        rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
      }
    }
    rows.push({ kind: "message", block });
    if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
    if (block.at !== undefined) lastAt = block.at;
  }
  flushLetters();
  flushActivity();
  return rows;
}

function footerFor(block: Block, usage: TurnUsage): Row {
  return {
    kind: "footer",
    id: `footer-${block.id}`,
    usage,
    ...(block.at !== undefined ? { at: block.at } : {}),
  };
}

/** Same speaker 6, a change of speaker 20, meta 12; the footer hugs its reply. */
export function gapBefore(prev: Row | undefined, current: Row): number {
  if (!prev) return 0;
  if (current.kind === "footer") return 6;
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return 12;
  if (from === to) return 6;
  return 20;
}

/** The pending tool row already is the live state; a Thinking line only fills a true gap. */
export function showThinking(blocks: Block[], working: boolean): boolean {
  if (!working) return false;
  const last = blocks.at(-1);
  if (!last) return true;
  if ((last.role === "assistant" || last.role === "reasoning") && last.streaming && last.text) return false;
  return !isOpen(last);
}
