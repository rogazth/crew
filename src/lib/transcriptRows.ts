/**
 * What the chat actually shows, from the blocks it holds.
 *
 * Tools, reasoning, approvals and questions collapse into one activity group;
 * messages stand alone; a turn's cost is a row of its own under whatever ended
 * the turn. The component below this renders rows and nothing else, so the
 * decisions live here where they can be checked.
 */
import { type Block, type TurnUsage } from "./blocks";
import { isLetter, isRefused, letterIdOf } from "./letters";

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
  | { kind: "fold"; id: string; rows: Row[]; durationMs?: number; failed: boolean }
  /** A letter sent or received: who wrote to whom, the words a click away in the pair's thread. */
  | { kind: "letter"; block: Block }
  /** A send Crew refused, with its reason. */
  | { kind: "refused"; block: Block }
  /** What waits for the next turn, under one label: messages typed, letters in the box. */
  | { kind: "queued"; id: string; blocks: Block[] };

export type Speaker = "user" | "agent" | "meta";

export function speaker(row: Row): Speaker {
  if (row.kind === "activity" || row.kind === "footer" || row.kind === "fold") return "agent";
  // A checkpoint is a mark in the run, whichever way the letter went.
  if (row.kind === "date" || row.kind === "letter" || row.kind === "refused") return "meta";
  if (row.kind === "queued") return "user";
  // A letter from a bot is a row in the run, not a side of the
  // conversation: it gets a note's room, not a change of speaker's.
  if (row.block.role === "user") return row.block.fromBot ? "meta" : "user";
  if (row.block.role === "system") return "meta";
  return "agent";
}

/**
 * A message typed into a CLI its history does not show yet, or a letter
 * still in the box: it waits for a turn rather than being part of one.
 */
export function isQueued(block: Block): boolean {
  return block.role === "user" && block.streaming === true;
}

export function groupRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  let lastAt: number | undefined;
  /** A letter's checkpoint once: the call's row and the note it left share an id. */
  const letters = new Set<string>();
  let queued: Block[] = [];
  const flushQueued = () => {
    if (queued.length === 0) return;
    rows.push({ kind: "queued", id: `queued-${queued[0]!.id}`, blocks: queued });
    queued = [];
  };
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
    if (isQueued(block)) {
      flush();
      queued.push(block);
      continue;
    }
    flushQueued();
    const letter = isLetter(block) ? letterIdOf(block) : undefined;
    if (letter !== undefined && letters.has(letter)) continue;
    // A letter stands out of the group around it, so a fold can leave it on the rail.
    if (letter !== undefined || isRefused(block)) {
      if (letter !== undefined) letters.add(letter);
      if (block.hidden) continue;
      flush();
      if (block.role === "user" && block.at !== undefined) {
        if (lastAt === undefined || block.at - lastAt > DATE_BREAK_MS) {
          rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
        }
      }
      rows.push({ kind: letter !== undefined ? "letter" : "refused", block });
      // A turn that ended on the send: its cost goes under it.
      if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
      if (block.at !== undefined && block.role !== "tool") lastAt = block.at;
      continue;
    }
    if (ACTIVITY_ROLES.has(block.role)) {
      activity.push(block);
      // The turn ended here: whatever comes next is another turn's work.
      if (block.usage) {
        activityFooter = footerFor(block, block.usage);
        flush();
      }
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
  flushQueued();
  return rows;
}

/** The queue at the foot, apart: it goes under the working line, not into a turn. */
export function splitQueued(rows: Row[]): { rows: Row[]; queued: Block[] } {
  const last = rows.at(-1);
  if (last?.kind !== "queued") return { rows, queued: [] };
  return { rows: rows.slice(0, -1), queued: last.blocks };
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
  return (row.kind === "message" || row.kind === "letter") && row.block.role === "user";
}

function isReply(row: Row): boolean {
  return row.kind === "message" && row.block.role === "assistant";
}

/** What opens a turn and stays above its fold: the question, or the note
 *  that says what woke the agent when nobody asked (a report, a routine). */
function isOpening(row: Row): boolean {
  return (row.kind === "message" || row.kind === "letter") && (row.block.role === "user" || row.block.role === "system");
}

/** What stays on the rail when a turn folds: who wrote to whom, and what was refused. */
function staysOut(row: Row): boolean {
  return row.kind === "letter" || row.kind === "refused";
}

/** Every block a row holds, a fold's included: what a search hit is looked for in. */
export function rowBlocks(row: Row): Block[] {
  if (row.kind === "message" || row.kind === "letter" || row.kind === "refused") return [row.block];
  if (row.kind === "activity" || row.kind === "queued") return row.blocks;
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
 *
 * A turn ends at its footer, not at the next question: an agent woken by a
 * report it was waiting on answers in a turn of its own, with no question
 * above it, and that answer is as much an answer as any other.
 *
 * Letters sent or received on the way stay out of the fold, under it, in the
 * order they came: a checkpoint is where the conversation with someone else
 * happened, and a folded turn must not hide that it did.
 */
export function foldTurns(rows: Row[], working: boolean): Row[] {
  const out: Row[] = [];
  let turn: Row[] = [];
  const close = (live: boolean) => {
    out.push(...(live ? turn : foldTurn(turn)));
    turn = [];
  };
  for (const row of rows) {
    if (row.kind === "date" || isUser(row)) close(false);
    if (row.kind === "date") {
      out.push(row);
      continue;
    }
    turn.push(row);
    if (row.kind === "footer") close(false);
  }
  close(working);
  return out;
}

function foldTurn(turn: Row[]): Row[] {
  let opening = 0;
  while (opening < turn.length && isOpening(turn[opening]!)) opening += 1;
  let answer = -1;
  for (let index = turn.length - 1; index >= opening; index -= 1) {
    if (isReply(turn[index]!)) {
      answer = index;
      break;
    }
  }
  const span = answer >= 0 ? turn.slice(opening, answer) : [];
  const work = span.filter((row) => !staysOut(row));
  const out = span.filter(staysOut);
  if (work.length < 2 || !work.some((row) => row.kind === "activity")) return turn;
  const reply = turn[answer]!;
  const blocks = work.flatMap(rowBlocks);
  // Its own footer, which closes it: never an earlier turn's.
  const last = turn.at(-1);
  const footer = last?.kind === "footer" ? last : undefined;
  const first = turn[0];
  const started = opening > 0 && (first?.kind === "message" || first?.kind === "letter") ? first.block.at : undefined;
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
  return [...turn.slice(0, opening), fold, ...out, ...rest];
}

function rowId(row: Row): string {
  return row.kind === "message" || row.kind === "letter" || row.kind === "refused" ? row.block.id : row.id;
}
