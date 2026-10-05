import type { AttachedFile, Block } from "./blocks";
import type { SessionAsk } from "./protocol";

/** A message the chat typed into the CLI, shown until the CLI's history has it. */
export type Queued = { id: string; text: string; files: AttachedFile[]; at: number };

/** How far a CLI's clock and ours may disagree when a queued message is matched to its turn. */
const CLOCK_SLACK_MS = 5000;

/** The text as compared: spaces folded, and a plugin's command (`/plugin:name`) by the name it was typed as. */
const squash = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/[^\s/:]+:/, "/");

/**
 * The queued messages whose user turn is in the history yet. The CLI may
 * dress the text (Claude turns a pasted image path into `[Image #1]`, and
 * writes a plugin's `/name` as `/plugin:name`), so a turn written after the
 * send that ends with the text is the match; each turn answers for one send.
 */
export function delivered(queued: readonly Queued[], blocks: readonly Block[]): Set<string> {
  const done = new Set<string>();
  const used = new Set<string>();
  for (const sent of queued) {
    const text = squash(sent.text);
    const turn = blocks.find(
      (block) =>
        block.role === "user" &&
        !used.has(block.id) &&
        (block.at ?? 0) >= sent.at - CLOCK_SLACK_MS &&
        (text === "" || squash(block.text).endsWith(text)),
    );
    if (!turn) continue;
    used.add(turn.id);
    done.add(sent.id);
  }
  return done;
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
