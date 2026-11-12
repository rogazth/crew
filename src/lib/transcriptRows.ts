/**
 * What the chat actually shows, from the blocks it holds.
 *
 * Tools, reasoning, approvals and questions collapse into one activity group;
 * messages stand alone; a turn's cost is a row of its own under whatever ended
 * the turn. The component below this renders rows and nothing else, so the
 * decisions live here where they can be checked.
 */
import { allFailed, type Block, type TurnUsage } from "./blocks";
import { isLetter, isRefused, isSteering, isWaiting, letterIdOf } from "./letters";
import { controlOf, isPeek, isReportLetter, nativeReportAt, startedOf, startNoteTarget, waitedReport } from "./orchestration";
import { agentDetail } from "./subagent";
import { isAuthFailure } from "./auth";
import { describeApproval, type ApprovalKind } from "./approvals";

/** A gap this long between messages gets a date line, like a chat app. */
/** Whether two moments fall on different days, where the transcript marks a new one. */
function newDay(at: number, last: number | undefined): boolean {
  if (last === undefined) return true;
  const a = new Date(at);
  const b = new Date(last);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

const ACTIVITY_ROLES = new Set(["tool", "approval", "question", "reasoning"]);

export type Row =
  /** `answer`: in an agent's thread, what the agent said at the end of a turn; a report when another party woke it. */
  | { kind: "message"; block: Block; answer?: "reply" | "report" }
  | { kind: "activity"; id: string; blocks: Block[] }
  /** `text` is the reply the footer closes, for its copy button; absent under a group.
   *  `folded`: the turn's work sits behind a fold that already says how long it took. */
  | { kind: "footer"; id: string; usage: TurnUsage; at?: number; text?: string; folded?: boolean }
  | { kind: "date"; id: string; at: number }
  /** A settled turn's work before its answer, behind one line. */
  | { kind: "fold"; id: string; rows: Row[]; durationMs?: number; failed: boolean }
  /** A letter sent or received: a message out with its card, a letter in from another party. */
  | { kind: "letter"; block: Block }
  /** A send Crew refused, with its reason. */
  | { kind: "refused"; block: Block }
  /** What waits for the next turn, under one label: messages typed, letters in the box. */
  | { kind: "queued"; id: string; blocks: Block[] }
  /** The call that sent a command to the background: a marker that opens its output. */
  | { kind: "background"; block: Block }
  /** A native subagent's call (Claude `Task`/`Agent`, Codex's agent thread, opencode `task`): one row and one card, out of any fold. */
  | { kind: "subagent"; block: Block }
  /** A Crew call that started something: `delegate`, `start_session`, `start_sessions`. */
  | { kind: "started"; block: Block }
  /** A Crew control call (`interrupt_session`, `read_session`, `list_peers`, `stop_session`, `update_session`): one line. */
  | { kind: "control"; block: Block }
  /** A Crew subagent's report letter, drawn where it arrived. */
  | { kind: "report"; block: Block }
  /** Files the agent sent the user (`SendUserFile`): shown like a reply, never folded away. */
  | { kind: "shared"; block: Block }
  /** An approval the user decided or a question they answered: the card stays, settled, out of any fold. */
  | { kind: "decision"; block: Block };

export type Speaker = "user" | "agent" | "meta";

export function speaker(row: Row): Speaker {
  if (
    row.kind === "activity" ||
    row.kind === "footer" ||
    row.kind === "fold" ||
    row.kind === "subagent" ||
    row.kind === "started" ||
    row.kind === "control" ||
    row.kind === "shared" ||
    row.kind === "decision"
  ) {
    return "agent";
  }
  // A checkpoint is a mark in the run, whichever way the letter went.
  if (row.kind === "date" || row.kind === "letter" || row.kind === "report" || row.kind === "refused" || row.kind === "background") return "meta";
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

/** Claude Code's tool for putting files in front of the user. */
const SHARE_TOOL = "SendUserFile";

/** A call that sent the user files, once they are known: the files are the point, not the call. */
export function isShared(block: Block): boolean {
  return block.role === "tool" && block.tool?.name === SHARE_TOOL && (block.files?.length ?? 0) > 0;
}

/**
 * `background` names the tool calls that left a command running in the
 * background: each is drawn as a marker of its own, out of the group around
 * it, so a folded turn still shows where it started. A subagent call and a
 * Crew call that started something are drawn the same way.
 */
export function groupRows(blocks: Block[], background?: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  let lastAt: number | undefined;
  /** A letter's checkpoint once: the call's row and the note it left share an id. */
  const letters = new Set<string>();
  /** The ids a start row names: the note the start leaves says the same and is dropped. */
  const started = new Set<string>();
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
    // The daemon marks a child's turn end for whoever reads it as text; the chat already shows it ended.
    if (block.role === "system" && block.text === "Turn ended") continue;
    if (isQueued(block)) {
      flush();
      queued.push(block);
      continue;
    }
    flushQueued();
    const start = startedOf(block);
    if (start) {
      flush();
      rows.push({ kind: "started", block });
      const letterId = letterIdOf(block);
      if (letterId !== undefined) letters.add(letterId);
      if (start.kind === "sessions") {
        for (const target of start.targets) if (target.id) started.add(target.id);
      } else if (start.target.id) started.add(start.target.id);
      if (block.usage) rows.push(footerFor(block, block.usage));
      continue;
    }
    // A call that only looked is a step of the run; one that changed something is a beat.
    if (controlOf(block) && !isPeek(block)) {
      flush();
      rows.push({ kind: "control", block });
      if (block.usage) rows.push(footerFor(block, block.usage));
      continue;
    }
    const noted = startNoteTarget(block);
    if (noted !== null && started.has(noted)) continue;
    const letter = isLetter(block) ? letterIdOf(block) : undefined;
    if (letter !== undefined && letters.has(letter)) continue;
    // A letter stands out of the group around it, so a fold can leave it on the rail.
    if (letter !== undefined || isRefused(block)) {
      if (letter !== undefined) letters.add(letter);
      if (block.hidden) continue;
      flush();
      if (block.role === "user" && block.at !== undefined) {
        if (newDay(block.at, lastAt)) {
          rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
        }
      }
      rows.push({ kind: isReportLetter(block) ? "report" : letter !== undefined ? "letter" : "refused", block });
      // A turn that ended on the send: its cost goes under it.
      if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
      if (block.at !== undefined && block.role !== "tool") lastAt = block.at;
      continue;
    }
    if (isShared(block)) {
      flush();
      rows.push({ kind: "shared", block });
      if (block.usage) rows.push(footerFor(block, block.usage));
      continue;
    }
    if (agentDetail(block)) {
      flush();
      rows.push({ kind: "subagent", block });
      continue;
    }
    if (block.role === "tool" && block.tool && background?.has(block.tool.callId)) {
      flush();
      rows.push({ kind: "background", block });
      continue;
    }
    // A card the user settled stays where it was asked, as the card it was: never in a group's summary or a fold.
    if (settled(block)) {
      flush();
      rows.push({ kind: "decision", block });
      if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
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
      if (newDay(block.at, lastAt)) {
        rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
      }
    }
    rows.push({ kind: "message", block });
    if (block.usage && !block.streaming) rows.push(footerFor(block, block.usage));
    if (block.at !== undefined) lastAt = block.at;
  }
  flush();
  flushQueued();
  return withNativeReports(rows, blocks);
}

/**
 * A decision that outlasts its call, so it keeps a card once made: an answer,
 * a plan, more access or work outside the project, and any "always allow",
 * which sets a rule for every call after it. A one-off yes or no to an edit,
 * a read, a command is already in that call's line in the trace, and folds
 * with the rest of the turn: a user asked at every step would otherwise get
 * a card per step.
 */
export function settled(block: Block): boolean {
  const approval = block.approval;
  if (approval?.decided) {
    if (approval.decided === "always") return true;
    return LASTING.has(describeApproval(approval.name, approval.input, block.tool?.title ?? block.text).kind);
  }
  return block.role === "question" && block.question != null && (block.question.answers != null || block.question.dismissed === true);
}

const LASTING = new Set<ApprovalKind>(["plan", "permissions", "outside"]);

/** The last moment a row covers, so a report can be placed after what came before it. */
function rowEndAt(row: Row): number | undefined {
  if (row.kind === "activity" || row.kind === "queued") return row.blocks.at(-1)?.at;
  if (row.kind === "footer" || row.kind === "date") return row.at;
  if (row.kind === "fold") return row.rows.length > 0 ? rowEndAt(row.rows[row.rows.length - 1]!) : undefined;
  return row.block.at;
}

/**
 * A native subagent's report is drawn where it landed, not under the card of
 * the call that started it: three agents asked together answer later, each when
 * it is done, and a report pinned to its start would read out of order.
 *
 * A `delegate` that waited brought its report back in its answer, and the agent
 * went on only once it had it: the report landed before whatever the agent did
 * next that was not another call of the same batch.
 */
function withNativeReports(rows: Row[], blocks: readonly Block[]): Row[] {
  const reports = blocks
    .map((block, index) => ({ block, at: nativeReportAt(block) ?? waitedReportAt(blocks, index) }))
    .filter((entry): entry is { block: Block; at: number } => entry.at !== undefined)
    .sort((a, b) => a.at - b.at);
  if (reports.length === 0) return rows;
  const out = rows.slice();
  for (const { block, at } of reports) {
    // The start row stays as it is; a suffixed id keeps both rows apart.
    const report: Row = { kind: "report", block: { ...block, id: `${block.id}:report` } };
    const found = out.findIndex((row) => {
      const end = rowEndAt(row);
      return end !== undefined && end > at;
    });
    out.splice(found < 0 ? out.length : found, 0, report);
  }
  return out;
}

/**
 * The report a start row is followed by, when both are about the same agent:
 * the two read as one beat, "Explore finished". A native subagent's or a waited
 * `delegate`'s report carries the call's id; a Crew report letter, the session's.
 */
export function reportAfter(start: Row | undefined, next: Row | undefined): Block | undefined {
  if (next?.kind !== "report" || (start?.kind !== "subagent" && start?.kind !== "started")) return undefined;
  if (next.block.id === `${start.block.id}:report`) return next.block;
  if (start.kind !== "started") return undefined;
  const started = startedOf(start.block);
  const id = started && started.kind !== "sessions" ? started.target.id : undefined;
  return id && next.block.fromBot?.id === id ? next.block : undefined;
}

/** Just before the first thing after a waited `delegate` that is not a call: the call returned with its report before it. */
function waitedReportAt(blocks: readonly Block[], index: number): number | undefined {
  const block = blocks[index]!;
  if (!waitedReport(block) || block.at === undefined) return undefined;
  const next = blocks.slice(index + 1).find((later) => later.role !== "tool" && later.at !== undefined);
  return next ? next.at! - 1 : Number.MAX_SAFE_INTEGER;
}

/** The queue at the foot, apart: it goes under the working line, not into a turn. */
export function splitQueued(rows: Row[]): { rows: Row[]; queued: Block[] } {
  const last = rows.at(-1);
  if (last?.kind !== "queued") return { rows, queued: [] };
  return { rows: rows.slice(0, -1), queued: last.blocks };
}

function footerFor(block: Block, usage: TurnUsage): Row {
  // A turn the CLI refused for want of a login did no work: no "Worked" under it.
  const idle = block.role === "system" && isAuthFailure(block.text);
  return {
    kind: "footer",
    id: `footer-${block.id}`,
    usage: idle ? withoutDuration(usage) : usage,
    ...(block.at !== undefined ? { at: block.at } : {}),
    ...(block.role === "assistant" && block.text.trim() ? { text: block.text } : {}),
  };
}

function withoutDuration(usage: TurnUsage): TurnUsage {
  const out = { ...usage };
  delete out.durationMs;
  return out;
}

/** The rows drawn as a beat: who did what to whom, on one centred line. */
const BEATS = new Set<Row["kind"]>(["subagent", "started", "report", "letter"]);

/** Same speaker 10, a change of speaker 28, meta 16; the footer hugs its reply. */
export function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  if (current.kind === "footer") return "mt-2";
  // Calls sit tighter than paragraphs: two runs in a row read as one.
  if (prev.kind === "activity" && current.kind === "activity") return "mt-0.5";
  // A run of beats is one list, whoever each beat is about: a start, a report, a letter.
  if (BEATS.has(prev.kind) && BEATS.has(current.kind)) return "mt-2.5";
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return "mt-4";
  if (from === to) return "mt-2.5";
  return "mt-7";
}


function isUser(row: Row): boolean {
  return (row.kind === "message" || row.kind === "letter" || row.kind === "report") && row.block.role === "user";
}

function isReply(row: Row): boolean {
  return row.kind === "message" && row.block.role === "assistant";
}

/** What opens a turn and stays above its fold: the question, or the note
 *  that says what woke the agent when nobody asked (a report, a routine). */
function isOpening(row: Row): boolean {
  return (
    (row.kind === "message" || row.kind === "letter" || row.kind === "report") &&
    (row.block.role === "user" || row.block.role === "system")
  );
}

/** What stays on the rail when a turn folds: who wrote to whom, what was refused, what went to the background. */
function staysOut(row: Row): boolean {
  return (
    row.kind === "letter" ||
    row.kind === "report" ||
    row.kind === "refused" ||
    row.kind === "background" ||
    row.kind === "subagent" ||
    row.kind === "started" ||
    row.kind === "control" ||
    row.kind === "shared" ||
    row.kind === "decision"
  );
}

/** Every block a row holds, a fold's included: what a search hit is looked for in. */
export function rowBlocks(row: Row): Block[] {
  if (
    row.kind === "message" ||
    row.kind === "letter" ||
    row.kind === "report" ||
    row.kind === "refused" ||
    row.kind === "background" ||
    row.kind === "subagent" ||
    row.kind === "started" ||
    row.kind === "control" ||
    row.kind === "shared" ||
    row.kind === "decision"
  ) {
    return [row.block];
  }
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
  rows = withFooters(rows, working);
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

/**
 * Every finished answer gets its line (copy, the time), whether or not its
 * provider reported what the turn cost: Codex and Cursor close a turn with no
 * usage, and their answers would otherwise end on nothing. A turn ends at the
 * next thing the user said; the one still running gets its line when it ends.
 */
function withFooters(rows: Row[], working: boolean): Row[] {
  const out: Row[] = [];
  let start = 0;
  const close = (live: boolean) => {
    const turn = out.slice(start);
    const last = turn.at(-1);
    if (!live && last?.kind === "message" && last.block.role === "assistant" && !last.block.streaming && !turn.some((row) => row.kind === "footer")) {
      out.push({
        kind: "footer",
        id: `footer-${last.block.id}`,
        usage: {},
        ...(last.block.at !== undefined ? { at: last.block.at } : {}),
        ...(last.block.text.trim() ? { text: last.block.text } : {}),
      });
    }
    start = out.length;
  };
  for (const row of rows) {
    if (row.kind === "date" || isUser(row)) close(false);
    out.push(row);
    if (row.kind === "footer") start = out.length;
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
  if (answer < 0) return turn;
  const span = turn.slice(opening, answer);
  const reply = turn[answer]!;
  // Its own footer, which closes it: never an earlier turn's.
  const last = turn.at(-1);
  const footer = last?.kind === "footer" ? last : undefined;
  const first = turn[0];
  const started = opening > 0 && (first?.kind === "message" || first?.kind === "letter" || first?.kind === "report") ? first.block.at : undefined;
  const ended = reply.kind === "message" ? reply.block.at : undefined;
  // What the agent wrote for the reader on the way stays in sight, where it
  // said it; the work on either side of it folds on its own.
  const said = span.filter(isOutputRow);
  const pieces: Row[][] = [[]];
  for (const row of span) {
    if (isOutputRow(row)) pieces.push([]);
    else pieces.at(-1)!.push(row);
  }
  const folded: Row[] = [];
  let any = false;
  pieces.forEach((piece, index) => {
    const from = index === 0 ? started : messageAt(said[index - 1]!);
    const to = index < said.length ? messageAt(said[index]!) : ended;
    const between = from !== undefined && to !== undefined ? to - from : undefined;
    // One piece is the whole turn: its cost already says how long it took.
    const durationMs = said.length === 0 ? (footer?.usage.durationMs ?? between) : between;
    const rows = foldPiece(piece, durationMs);
    if (rows !== piece) any = true;
    folded.push(...rows);
    if (index < said.length) folded.push(said[index]!);
  });
  if (!any) return turn;
  const rest = turn.slice(answer).map((row) => (row.kind === "footer" && said.length === 0 ? { ...row, folded: true } : row));
  return [...turn.slice(0, opening), ...folded, ...rest];
}

/** The work between two things the reader sees, behind one line; the beats in it stay out, under it. */
function foldPiece(piece: Row[], durationMs: number | undefined): Row[] {
  const work = piece.filter((row) => !staysOut(row));
  if (work.length < 2 || !work.some((row) => row.kind === "activity")) return piece;
  const fold: Row = {
    kind: "fold",
    id: `fold-${rowId(work[0]!)}`,
    rows: work,
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    failed: allFailed(work.flatMap(rowBlocks)),
  };
  return [fold, ...piece.filter(staysOut)];
}

/** Longer than a note to self, by this many characters, it was written to be read. */
const NOTE_MAX = 400;

/**
 * A message the agent wrote on the way that is output, not a note between two
 * calls ("Now the tests."): a heading, a list, a table, a quote, code, or long.
 */
function isOutputRow(row: Row): boolean {
  if (row.kind !== "message" || row.block.role !== "assistant") return false;
  const text = row.block.text.trim();
  return text.length > NOTE_MAX || /^(?:#{1,6} |```|~~~|\||> |[-*+] |\d+[.)] )/m.test(text);
}

function messageAt(row: Row): number | undefined {
  return row.kind === "message" ? row.block.at : undefined;
}

/**
 * An agent's thread as one conversation: who said what is its spine, and what
 * the agent did between two messages is one line that opens. The agent's own
 * notes between tools are work. What waits on someone (a question, an approval)
 * and what is still running is never folded.
 */
export function threadRows(rows: readonly Row[], working: boolean): Row[] {
  const out: Row[] = [];
  let work: Row[] = [];
  /** Another party's letter started this turn: what ends it goes back to them. */
  let woken = false;
  const flush = () => {
    if (work.length === 0) return;
    const blocks = work.flatMap(rowBlocks);
    const first = blocks[0]?.at;
    const last = blocks.at(-1)?.at;
    out.push({
      kind: "fold",
      id: `fold-${rowId(work[0]!)}`,
      rows: work,
      ...(first !== undefined && last !== undefined && last > first ? { durationMs: last - first } : {}),
      failed: allFailed(blocks),
    });
    work = [];
  };
  rows.forEach((row, index) => {
    switch (row.kind) {
      case "footer":
        return;
      case "activity": {
        let tools: Block[] = [];
        const close = () => {
          if (tools.length > 0) work.push({ kind: "activity", id: tools[0]!.id, blocks: tools });
          tools = [];
        };
        for (const block of row.blocks) {
          if (block.role !== "question" && block.role !== "approval") {
            tools.push(block);
            continue;
          }
          close();
          flush();
          out.push({ kind: "activity", id: block.id, blocks: [block] });
        }
        close();
        return;
      }
      case "control":
      case "background":
        work.push(row);
        return;
      case "decision":
        flush();
        out.push(row);
        return;
      case "message": {
        if (row.block.role !== "assistant") {
          flush();
          if (row.block.role === "user") woken = false;
          out.push(row);
          return;
        }
        const ends = rows[index + 1]?.kind === "footer" || (!working && index === rows.length - 1);
        if (!ends) {
          work.push(row);
          return;
        }
        flush();
        out.push({ ...row, answer: woken ? "report" : "reply" });
        woken = false;
        return;
      }
      default:
        flush();
        if (row.kind === "letter" && row.block.role === "user") woken = true;
        out.push(row);
    }
  });
  // The work going on now is what the reader is watching.
  if (working) out.push(...work);
  else flush();
  return out;
}

function rowId(row: Row): string {
  return row.kind === "message" ||
    row.kind === "letter" ||
    row.kind === "report" ||
    row.kind === "refused" ||
    row.kind === "background" ||
    row.kind === "subagent" ||
    row.kind === "started" ||
    row.kind === "control" ||
    row.kind === "shared" ||
    row.kind === "decision"
    ? row.block.id
    : row.id;
}

/** Where a turn ended: the block its footer hangs on. */
const endsTurn = (block: Block) => block.usage !== undefined && block.streaming !== true;

/**
 * When the turn now running began. The transcript says so: its newest user
 * turn by time, once that is newer than the last turn's end. Until the turn
 * is written, the queued message sent after that end started it; with
 * neither (the agent took up work by itself) it began when the last one
 * ended. Never the last bubble in the list for being last: a stale one would
 * date the turn from whenever it was sent.
 */
export function turnStart(blocks: readonly Block[]): number | undefined {
  let user: number | undefined;
  let ended: number | undefined;
  const sent: number[] = [];
  for (const block of blocks) {
    // A steer is part of the turn already running, and a letter still in the box waits for the next: neither starts this one.
    if (block.at === undefined || isSteering(block) || isWaiting(block)) continue;
    if (isQueued(block)) sent.push(block.at);
    else if (block.role === "user") user = Math.max(user ?? block.at, block.at);
    else if (endsTurn(block)) ended = Math.max(ended ?? block.at, block.at);
  }
  if (user !== undefined && (ended === undefined || user > ended)) return user;
  const queued = sent.filter((at) => ended === undefined || at >= ended);
  if (queued.length > 0) return Math.min(...queued);
  return ended ?? user;
}

/**
 * The queued message the running turn has already taken, when the transcript
 * has not written that turn yet. A send that arrives while a turn is already
 * in the transcript is still waiting.
 */
export function underway(blocks: readonly Block[], working: boolean): Block | undefined {
  if (!working) return undefined;
  let user: number | undefined;
  let ended: number | undefined;
  const queued: Block[] = [];
  for (const block of blocks) {
    if (block.at === undefined || isSteering(block) || isWaiting(block)) continue;
    if (isQueued(block) && !block.fromBot) queued.push(block);
    else if (block.role === "user") user = Math.max(user ?? block.at, block.at);
    else if (endsTurn(block)) ended = Math.max(ended ?? block.at, block.at);
  }
  if (user !== undefined && (ended === undefined || user > ended)) return undefined;
  const waiting = queued.filter((block) => ended === undefined || (block.at ?? 0) >= ended);
  if (waiting.length === 0) return undefined;
  return waiting.reduce((earliest, block) => ((block.at ?? 0) < (earliest.at ?? 0) ? block : earliest));
}
