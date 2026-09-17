/**
 * What the chat actually shows, from the blocks it holds.
 *
 * Tools, reasoning, approvals and questions collapse into one activity group;
 * messages stand alone; a turn's cost is a row of its own under whatever ended
 * the turn. The component below this renders rows and nothing else, so the
 * decisions live here where they can be checked.
 */
import { type Block, type TurnUsage } from "./blocks";

/** A gap this long between messages gets a date line, like a chat app. */
const DATE_BREAK_MS = 30 * 60_000;

const ACTIVITY_ROLES = new Set(["tool", "approval", "question", "reasoning"]);

export type Row =
  | { kind: "message"; block: Block }
  | { kind: "activity"; id: string; blocks: Block[] }
  | { kind: "footer"; id: string; usage: TurnUsage; at?: number }
  | { kind: "date"; id: string; at: number };

export type Speaker = "user" | "agent" | "meta";

export function speaker(row: Row): Speaker {
  if (row.kind === "activity" || row.kind === "footer") return "agent";
  if (row.kind === "date") return "meta";
  // A letter from another agent is a row in the run, not a side of the
  // conversation: it gets a note's room, not a change of speaker's.
  if (row.block.role === "user") return row.block.fromAgent ? "meta" : "user";
  if (row.block.role === "system") return "meta";
  return "agent";
}

export function groupRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  let lastAt: number | undefined;
  /** A turn that ended on a tool call: its cost belongs under the group, not in it. */
  let activityFooter: Row | null = null;
  const flush = () => {
    if (activity.length === 0) return;
    rows.push({ kind: "activity", id: activity[0]!.id, blocks: activity });
    activity = [];
    if (activityFooter) {
      rows.push(activityFooter);
      activityFooter = null;
    }
  };
  for (const block of blocks) {
    if (ACTIVITY_ROLES.has(block.role)) {
      activity.push(block);
      if (block.usage) activityFooter = footerFor(block, block.usage);
      continue;
    }
    if (block.role === "assistant" && !block.text && block.streaming) continue;
    if (block.hidden) continue;
    flush();
    if (block.role === "user" && block.at !== undefined) {
      if (lastAt === undefined || block.at - lastAt > DATE_BREAK_MS) {
        rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
      }
    }
    rows.push({ kind: "message", block });
    if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
    if (block.at !== undefined) lastAt = block.at;
  }
  flush();
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
export function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  if (current.kind === "footer") return "mt-1.5";
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return "mt-3";
  if (from === to) return "mt-1.5";
  return "mt-5";
}
