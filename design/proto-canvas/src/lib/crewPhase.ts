import {
  crewTool,
  crewToolLine,
  type ActivityItem,
  type Block,
  type CrewToolKind,
  type CrewToolLine,
  type Phase,
} from "@crew/fixtures";
import type { GlyphName } from "@/ui/Icon";

export const CREW_GLYPH: Record<CrewToolKind, GlyphName> = {
  agent: "users",
  message: "send",
  routine: "repeat",
  self: "brain",
  search: "search",
  gateway: "wrench",
};

export const isCrew = (block: Block): boolean => crewTool(block.tool?.name ?? "") !== null;

export function crewLineOf(block: Block, resolve: (id: string) => string): CrewToolLine | null {
  const detail = block.tool?.detail;
  return crewToolLine(block.tool?.name ?? "", block.tool?.args, resolve, {
    ...(block.tool?.title ? { title: block.tool.title } : {}),
    ...(detail?.kind === "output" ? { output: detail.text } : {}),
  });
}

/**
 * A line that names another agent is an *event* — an agent was created, a letter
 * was sent. Everything else a Crew run does (listing the roster, resolving a
 * tool through the gateway) is plumbing, and folding the two together is how a
 * run that created one agent ends up reading "Ran 4 tools".
 */
const isEvent = (line: CrewToolLine): boolean => Boolean(line.peerName);

function linesOf(phase: Phase, resolve: (id: string) => string): CrewToolLine[] | null {
  const out: CrewToolLine[] = [];
  for (const block of phase.blocks) {
    const line = crewLineOf(block, resolve);
    if (!line) return null;
    out.push(line);
  }
  return out;
}

function summarise(lines: CrewToolLine[]): string | null {
  const events = lines.filter(isEvent);
  const source = events.length > 0 ? events : lines;

  const agents = source.filter((line) => line.kind === "agent");
  const messages = source.filter((line) => line.kind === "message");
  const peers = new Set(messages.map((line) => line.peerName));
  const parts: string[] = [];

  if (agents.length === 1) parts.push(agents[0]!.text);
  else if (agents.length > 1) parts.push(`Created ${agents.length} agents`);

  if (messages.length === 1) parts.push(messages[0]!.text);
  else if (messages.length > 1) {
    const [only] = peers;
    parts.push(peers.size === 1 && only ? `${messages.length} letters to ${only}` : `Wrote to ${peers.size} agents`);
  }

  if (parts.length === 0) {
    const rest = source.filter((line) => line.kind !== "agent" && line.kind !== "message");
    if (rest.length === 1) return rest[0]!.text;
    if (rest.length > 1) return `Ran ${rest.length} Crew tools`;
    return null;
  }

  const [head, tail] = parts;
  if (!tail) return head!;
  return `${head}, ${tail.charAt(0).toLowerCase()}${tail.slice(1)}`;
}

/**
 * Shared's `phaseLabel` folds every Crew tool into "Ran N tools", because they
 * all normalise to `other`. A run of agent-to-agent calls is the most legible
 * thing in a transcript, so Canvas labels it by what it did.
 */
export function crewPhaseLabel(phase: Phase, resolve: (id: string) => string): string | null {
  const lines = linesOf(phase, resolve);
  return lines ? summarise(lines) : null;
}

export function crewPhaseGlyph(phase: Phase, resolve: (id: string) => string): GlyphName | null {
  const lines = linesOf(phase, resolve);
  if (!lines || lines.length === 0) return null;
  const events = lines.filter(isEvent);
  return CREW_GLYPH[(events[0] ?? lines[0])!.kind];
}

/** The digest line when a whole run is Crew traffic. */
export function crewDigest(items: ActivityItem[], resolve: (id: string) => string): string | null {
  const phases = items.filter((item): item is Extract<ActivityItem, { kind: "phase" }> => item.kind === "phase");
  if (phases.length === 0) return null;
  const blocks = phases.flatMap((item) => item.phase.blocks);
  if (!blocks.every(isCrew)) return null;
  return crewPhaseLabel({ id: blocks[0]!.id, kind: "other", blocks }, resolve);
}
