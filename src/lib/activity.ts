import { isOpen, type Block } from "./blocks";
import { detailOf } from "./toolDetail";

/** What a run of tool calls was for. Drives the phase icon and its one-line label. */
export type PhaseKind = "edit" | "research" | "run" | "other";

export type Phase = { id: string; kind: PhaseKind; blocks: Block[] };

/** A phase folds tool calls; thinking and questions stand on their own. */
export type ActivityItem =
  | { kind: "phase"; phase: Phase }
  | { kind: "reasoning"; block: Block }
  | { kind: "question"; block: Block };

const EDIT = /^(edit|multiedit|write|notebookedit)$/i;
const RUN = /^(bash|shell|command|terminal)$/i;
const RESEARCH = /^(read|notebookread|glob|grep|ls|websearch|webfetch|search|find|list)$/i;

export function kindOf(name: string): PhaseKind {
  if (EDIT.test(name)) return "edit";
  if (RUN.test(name)) return "run";
  if (RESEARCH.test(name) || /search|fetch|read/i.test(name)) return "research";
  return "other";
}

/**
 * What the call was. The detail knows — Claude's `Bash`, Codex's `exec_command`
 * and opencode's `bash` all arrive as a command — so the name regexes above are
 * only the fallback for a provider that sent no detail.
 */
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
      return kindOf(toolName(block));
  }
}

function toolName(block: Block): string {
  return block.tool?.name ?? block.approval?.name ?? "";
}

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

export function phaseOpen(phase: Phase): boolean {
  return phase.blocks.some(isOpen);
}

/** A folded phase must still say that something in it went wrong. */
export function phaseFailed(phase: Phase): boolean {
  return phase.blocks.some((block) => block.tool?.status === "failed");
}

/** "Read sidebarPrefs.ts" → the file; "npm run lint" → nothing. */
function targetOf(block: Block): string | null {
  const detail = detailOf(block);
  if (detail?.kind === "file" || detail?.kind === "edit") return detail.path;
  if (detail) return null;
  const title = block.tool?.title ?? block.text;
  const match = /^(?:Read|Edit|Write|Glob|Grep|Search|Fetch|List)\s+(.+)$/.exec(title);
  return match?.[1] ?? null;
}

/** A phase counts a call as a search when the detail says so, name be damned. */
function isSearch(block: Block): boolean {
  const detail = detailOf(block);
  if (detail) return detail.kind === "search" || detail.kind === "fetch";
  return /^(glob|grep|websearch|search|find)$/i.test(toolName(block));
}

function fileLabel(files: Set<string>): string {
  if (files.size === 1) return [...files][0]!;
  return `${files.size} files`;
}

/**
 * One line for the folded phase. Present tense while any call is still open,
 * past once they all settled: "Reading 3 files" becomes "Read 3 files".
 */
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
      return files.size > 0 ? `${live ? "Editing" : "Edited"} ${fileLabel(files)}` : live ? "Editing" : "Edited";
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

/**
 * How many rows a run has to reach before it folds behind one line. Two rows
 * fold to one plus a click to get them back, which is not a trade worth making.
 */
export const FOLD_AT = 3;

/** What a folded run says it was: its line, and the glyph that line wears. */
export type ActivityDigest = { label: string; kind: PhaseKind | "thought" };

/**
 * One line for a whole run of activity. Phases of the same kind are counted
 * together however often thinking split them up, and the two biggest kinds
 * carry the line: "Ran 8 commands, read 2 files".
 */
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
  // Ties keep the order the kinds first appeared in: sort is stable, and a Map
  // iterates in insertion order.
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

function decap(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The first line of a thought, markdown noise stripped, for the folded row. */
export function summarize(text: string, max = 96): string {
  const line =
    text
      .split("\n")
      .map((row) => row.replace(/^[#>\-*\s]+/, "").replace(/[*_`]/g, "").trim())
      .find((row) => row.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
