import { isOpen, type Block } from "./blocks";

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
    const kind = kindOf(toolName(block));
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

/** "Read sidebarPrefs.ts" → the file; "npm run lint" → nothing. */
function targetOf(block: Block): string | null {
  const title = block.tool?.title ?? block.text;
  const match = /^(?:Read|Edit|Write|Glob|Grep|Search|Fetch|List)\s+(.+)$/.exec(title);
  return match?.[1] ?? null;
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
    const name = toolName(block);
    const target = targetOf(block);
    if (/^(glob|grep|websearch|search|find)$/i.test(name)) searches += 1;
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

/** The first line of a thought, markdown noise stripped, for the folded row. */
export function summarize(text: string, max = 96): string {
  const line =
    text
      .split("\n")
      .map((row) => row.replace(/^[#>\-*\s]+/, "").replace(/[*_`]/g, "").trim())
      .find((row) => row.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
