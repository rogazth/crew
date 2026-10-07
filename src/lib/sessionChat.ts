import type { AttachedFile, Block } from "./blocks";
import type { SessionAsk } from "./protocol";
import { isQueued } from "./transcriptRows";

/** A message the chat typed into the CLI, shown until the CLI's history has it. */
export type Queued = { id: string; text: string; files: AttachedFile[]; at: number };

/** How far a CLI's clock and ours may disagree when a queued message is matched to its turn. */
const CLOCK_SLACK_MS = 5000;
/** Cursor dates a prompt as the first millisecond of its minute, and a later read of the file keeps that. */
const MINUTE_MS = 60_000;

/** The text as compared: spaces folded, and a plugin's command (`/plugin:name`) by the name it was typed as. */
const squash = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/[^\s/:]+:/, "/");

/**
 * Whether `turn` is when `sent` was written. A CLI's clock may be a few
 * seconds ahead of ours. Cursor's stamp is the start of a minute, so a send
 * any time in that minute is still the turn.
 */
const sameTime = (provider: string, turn: number, sent: number) =>
  turn >= sent - CLOCK_SLACK_MS ||
  (provider === "cursor" && turn % MINUTE_MS === 0 && sent > turn && sent < turn + MINUTE_MS);

/**
 * The queued messages whose user turn is in the history yet. The CLI may
 * dress the text (Claude turns a pasted image path into `[Image #1]`, and
 * writes a plugin's `/name` as `/plugin:name`), so a turn written after the
 * send that ends with the text is the match; each turn answers for one send.
 */
export function delivered(queued: readonly Queued[], blocks: readonly Block[], provider: string): Set<string> {
  const done = new Set<string>();
  const used = new Set<string>();
  for (const sent of queued) {
    const text = squash(sent.text);
    const turn = blocks.find(
      (block) =>
        block.role === "user" &&
        !used.has(block.id) &&
        sameTime(provider, block.at ?? 0, sent.at) &&
        (text === "" || squash(block.text).endsWith(text)),
    );
    if (!turn) continue;
    used.add(turn.id);
    done.add(sent.id);
  }
  return done;
}

/** A queued bubble in a list of blocks: a user message not in the history yet (`queuedBlock`). */
/** Where a turn ended: the block its footer hangs on. */
const endsTurn = (block: Block) => block.usage !== undefined && block.streaming !== true;

/**
 * Queued messages the CLI has had their turn for: the history has a user
 * turn written after the send, and that turn has ended. Whatever the CLI
 * made of the message (joined it to another, wrapped it in something the
 * match does not know), it is not still coming, so its bubble goes rather
 * than wait forever.
 */
export function overdue(queued: readonly Queued[], blocks: readonly Block[]): Set<string> {
  const out = new Set<string>();
  for (const sent of queued) {
    const turn = blocks.findIndex((block) => block.role === "user" && !isQueued(block) && (block.at ?? 0) > sent.at);
    if (turn >= 0 && blocks.slice(turn + 1).some(endsTurn)) out.add(sent.id);
  }
  return out;
}

/**
 * When the turn now running began. The history says so: its newest user
 * turn by time, once that is newer than the last turn's end. Until the CLI
 * writes the turn, the queued message sent after that end started it; with
 * neither (the CLI took up work by itself) it began when the last one ended.
 * Never the last bubble in the list for being last: a stale one would date
 * the turn from whenever it was sent.
 */
export function turnStart(blocks: readonly Block[]): number | undefined {
  let user: number | undefined;
  let ended: number | undefined;
  const sent: number[] = [];
  for (const block of blocks) {
    if (block.at === undefined) continue;
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
 * The queued message the running turn has already taken, when the history has
 * not written that turn yet. Cursor records the prompt with the reply, so
 * until then the only sign the message was received is that the agent is at
 * work on it. A send that arrives while a turn is already in the history is
 * still waiting.
 */
export function underway(blocks: readonly Block[], working: boolean): Block | undefined {
  if (!working) return undefined;
  let user: number | undefined;
  let ended: number | undefined;
  const queued: Block[] = [];
  for (const block of blocks) {
    if (block.at === undefined) continue;
    if (isQueued(block) && !block.fromBot) queued.push(block);
    else if (block.role === "user") user = Math.max(user ?? block.at, block.at);
    else if (endsTurn(block)) ended = Math.max(ended ?? block.at, block.at);
  }
  if (user !== undefined && (ended === undefined || user > ended)) return undefined;
  const waiting = queued.filter((block) => ended === undefined || (block.at ?? 0) >= ended);
  if (waiting.length === 0) return undefined;
  return waiting.reduce((earliest, block) => ((block.at ?? 0) < (earliest.at ?? 0) ? block : earliest));
}

/** A queued message as a user bubble; `streaming` marks it as not in the history yet. */
export function queuedBlock(sent: Queued): Block {
  return {
    id: `queued:${sent.id}`,
    role: "user",
    text: sent.text,
    at: sent.at,
    streaming: true,
    ...(sent.files.length > 0 ? { files: sent.files } : {}),
  };
}

/**
 * What the CLI stopped to ask, as the card the chat answers it with. A
 * question form the history already shows open is that card, so it is not
 * drawn twice.
 */
export function askBlock(ask: SessionAsk, blocks: readonly Block[]): Block | null {
  if (ask.questions.length > 0) {
    if (openQuestion(blocks)) return null;
    return {
      id: `ask:${ask.id}`,
      role: "question",
      text: ask.questions[0]?.header || ask.questions[0]?.question || "Question",
      question: { requestId: ask.id, questions: ask.questions },
    };
  }
  return {
    id: `ask:${ask.id}`,
    role: "approval",
    text: ask.tool,
    approval: { requestId: ask.id, name: ask.tool, input: ask.input },
  };
}

/** The history's newest question form still waiting on an answer. */
export function openQuestion(blocks: readonly Block[]): Block | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const question = blocks[i]?.question;
    if (question) return !question.answers && !question.dismissed ? blocks[i]! : null;
  }
  return null;
}

/**
 * The blocks with what the CLI asks drawn in: a permission takes the place of
 * the pending call it is about (the history already has that call), so the
 * card stands where the call will run, as it does in a chat Crew drives.
 */
export function withAsk(blocks: readonly Block[], ask: SessionAsk | null): Block[] {
  const card = ask ? askBlock(ask, blocks) : null;
  if (!card) return [...blocks];
  if (card.role === "approval") {
    let at = blocks.length - 1;
    while (at >= 0 && blocks[at]?.tool === undefined) at -= 1;
    const call = blocks[at]?.tool;
    if (call && call.status === "pending" && call.name === ask?.tool) {
      return [...blocks.slice(0, at), card, ...blocks.slice(at + 1)];
    }
  }
  return [...blocks, card];
}
