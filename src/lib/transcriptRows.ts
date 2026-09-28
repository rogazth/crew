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
  /** `text` is the reply the footer closes, for its copy button; absent under a group.
   *  `folded`: the turn's work sits behind a fold that already says how long it took. */
  | { kind: "footer"; id: string; usage: TurnUsage; at?: number; text?: string; folded?: boolean }
  | { kind: "date"; id: string; at: number }
  /** A settled turn's work before its answer, behind one line. */
  | { kind: "fold"; id: string; rows: Row[]; durationMs?: number; failed: boolean };

export type Speaker = "user" | "agent" | "meta";

export function speaker(row: Row): Speaker {
  if (row.kind === "activity" || row.kind === "footer" || row.kind === "fold") return "agent";
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
    ...(block.role === "assistant" && block.text.trim() ? { text: block.text } : {}),
  };
}

/** Same speaker 10, a change of speaker 28, meta 16; the footer hugs its reply. */
export function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  if (current.kind === "footer") return "mt-2";
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return "mt-4";
  if (from === to) return "mt-2.5";
  return "mt-7";
}


function isUser(row: Row): boolean {
  return row.kind === "message" && row.block.role === "user";
}

function isReply(row: Row): boolean {
  return row.kind === "message" && row.block.role === "assistant";
}

/** Every block a row holds, a fold's included: what a search hit is looked for in. */
export function rowBlocks(row: Row): Block[] {
  if (row.kind === "message") return [row.block];
  if (row.kind === "activity") return row.blocks;
  if (row.kind === "fold") return row.rows.flatMap(rowBlocks);
  return [];
}

/**
 * Once a turn is over, what the agent did on the way to its answer is history:
 * the calls, the notes it wrote to itself between them, the thinking. They
 * fold behind one line, "Worked for 4m 12s", and the answer stands alone
 * under the question. A turn still running folds nothing — that is the work
 * the reader is watching — and neither does a turn with no answer, or one
 * whose work is already a single line.
 */
export function foldTurns(rows: Row[], working: boolean): Row[] {
  const out: Row[] = [];
  let at = 0;
  while (at < rows.length) {
    if (!isUser(rows[at]!)) {
      out.push(rows[at]!);
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < rows.length && !isUser(rows[end]!) && rows[end]!.kind !== "date") end += 1;
    const turn = rows.slice(at, end);
    const live = working && end === rows.length;
    out.push(...(live ? turn : foldTurn(turn)));
    at = end;
  }
  return out;
}

function foldTurn(turn: Row[]): Row[] {
  let answer = -1;
  for (let index = turn.length - 1; index > 0; index -= 1) {
    if (isReply(turn[index]!)) {
      answer = index;
      break;
    }
  }
  const work = answer > 0 ? turn.slice(1, answer) : [];
  if (work.length < 2 || !work.some((row) => row.kind === "activity")) return turn;
  const question = turn[0]!;
  const reply = turn[answer]!;
  const blocks = work.flatMap(rowBlocks);
  const footer = turn.find((row): row is Extract<Row, { kind: "footer" }> => row.kind === "footer");
  const started = question.kind === "message" ? question.block.at : undefined;
  const ended = reply.kind === "message" ? reply.block.at : undefined;
  const durationMs =
    footer?.usage.durationMs ?? (started !== undefined && ended !== undefined ? ended - started : undefined);
  const fold: Row = {
    kind: "fold",
    id: `fold-${rowId(work[0]!)}`,
    rows: work,
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    failed: blocks.some((block) => block.tool?.status === "failed"),
  };
  const rest = turn.slice(answer).map((row) => (row.kind === "footer" ? { ...row, folded: true } : row));
  return [question, fold, ...rest];
}

function rowId(row: Row): string {
  return row.kind === "message" ? row.block.id : row.id;
}
