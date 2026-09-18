import {
  compactNumber,
  crewToolLine,
  detailOf,
  modelLabel,
  type Block,
  type CrewToolKind,
  type CrewToolLine,
  type PhaseKind,
} from "@crew/fixtures";

/** Provider marks are monograms, never logos. */
export const MONOGRAM: Record<string, string> = {
  claude: "cl",
  cursor: "cx",
  codex: "cd",
  opencode: "oc",
};

export const monogramOf = (provider: string) => MONOGRAM[provider] ?? provider.slice(0, 2);

/** "Opus 5" reads as `opus-5` in a mono gutter. */
export function shortModel(provider: string, model: string): string {
  if (!model) return "pty";
  const label = modelLabel(provider, model).toLowerCase().replace(/\s+/g, "-");
  return label.length > 13 ? `${label.slice(0, 12)}…` : label;
}

const NAME_VERB: Array<[RegExp, string]> = [
  [/^(bash|shell|exec_command|terminal|command)$/i, "run"],
  [/^(read|read_file|notebookread)$/i, "read"],
  [/^(edit|multiedit|apply_patch|notebookedit)$/i, "edit"],
  [/^write$/i, "write"],
  [/^grep$/i, "grep"],
  [/^(glob|ls|list|find)$/i, "find"],
  [/^(websearch|search)$/i, "search"],
  [/^(webfetch|fetch)$/i, "fetch"],
  [/^(message_agent|message)$/i, "msg"],
  [/^task$/i, "task"],
];

const CREW_VERB: Record<CrewToolKind, string> = {
  agent: "agent",
  message: "msg",
  routine: "cron",
  self: "self",
  search: "find",
  gateway: "tool",
};

/**
 * Crew's own tools arrive as an `output` blob — the `{` bug in the wild. The
 * shared decoder turns them back into facts; this is where the log picks the
 * verb for one.
 */
export function crewLineOf(block: Block, resolve?: (id: string) => string): CrewToolLine | null {
  const tool = block.tool;
  if (!tool) return null;
  const detail = detailOf(block);
  return crewToolLine(tool.name, tool.args, resolve, {
    ...(tool.title ? { title: tool.title } : {}),
    ...(detail?.kind === "output" ? { output: detail.text } : {}),
  });
}

/** The gutter word: what the row did, in at most six characters. */
export function verbOf(block: Block, resolve?: (id: string) => string): string {
  const crew = crewLineOf(block, resolve);
  if (crew) return CREW_VERB[crew.kind];
  const detail = detailOf(block);
  switch (detail?.kind) {
    case "command":
      return "run";
    case "file":
      return "read";
    case "edit":
      return "edit";
    case "search":
      return "grep";
    case "fetch":
      return "fetch";
    case "message":
      return "msg";
    case "output":
      return "out";
    default:
      break;
  }
  const name = block.tool?.name ?? block.approval?.name ?? "";
  for (const [pattern, verb] of NAME_VERB) if (pattern.test(name)) return verb;
  const word = name.replace(/[_-]+/g, " ").split(" ")[0]?.toLowerCase() ?? "tool";
  return word.length > 6 ? word.slice(0, 6) : word || "tool";
}

export const PHASE_VERB: Record<PhaseKind, string> = {
  edit: "edit",
  research: "read",
  run: "run",
  other: "tool",
};

/** "18.4k in · 620 out · $0.09 · 21s" — the whole footer, no tooltip needed. */
export function usageLine(usage: {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${compactNumber(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${compactNumber(usage.outputTokens)} out`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  if (usage.durationMs !== undefined) {
    const seconds = Math.round(usage.durationMs / 1000);
    parts.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
  }
  return parts.join(" · ");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const fileName = (path: string) => path.split("/").pop() ?? path;
