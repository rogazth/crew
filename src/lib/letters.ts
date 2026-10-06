/**
 * Letters between sessions, as a chat draws them: who wrote to whom, at the
 * point it happened, and a way into that pair's thread. The words live in the
 * thread; the transcript keeps only the checkpoint.
 */
import type { Block, BotRef, ThreadLetter, ThreadPair } from "./protocol";
import type { Session } from "./types";

/** The id a thread names the person by. */
export const USER = "user";

/** One end of a letter: by id (`USER` for the person, `""` for a sender deleted since) and by name. */
export type Party = {
  id: string;
  name: string;
  /** As on a `BotRef`: absent for a bot; `session`, `terminal` or `user`. */
  kind?: string;
};

/** A letter as the transcript marks it: one arrow, and when. */
export type Checkpoint = { letterId: string; from: Party; to: Party; at?: number };

export const YOU: Party = { id: USER, name: "You", kind: "user" };

/** A `BotRef` as a party: the person goes by `USER` whatever id it came with. */
export function partyOf(ref: BotRef): Party {
  if (ref.kind === "user" || ref.id === USER) return YOU;
  return { id: ref.id, name: ref.name, ...(ref.kind !== undefined ? { kind: ref.kind } : {}) };
}

/** A session as a party, the chat's owner most often. */
export function sessionParty(session: Pick<Session, "id" | "name" | "kind">): Party {
  if (session.kind === "bot") return { id: session.id, name: session.name };
  return { id: session.id, name: session.name, kind: session.kind === "terminal" ? "terminal" : "session" };
}

/** "Started session Auth refactor (id)", "Handed Docs (id) to the user": the system lines a start leaves. */
const STARTED = /^(?:Started session (.+) \(([^()]+)\)|Handed (.+) \(([^()]+)\) to the user)$/;
/** The line a parent gets when the user writes to its child. */
const WROTE = /^You wrote to (.+)$/;

/**
 * Whether a block is a letter's checkpoint rather than a message or a call:
 * the sender's `send_message` / `start_session` row, the receiver's turn, or
 * the note a start or the user's write to a child leaves. A user block with
 * no sender is the person typing in this chat: their bubble, not a checkpoint.
 */
export function isLetter(block: Block): boolean {
  if (block.role === "tool") {
    const detail = block.tool?.detail;
    return detail?.kind === "message" && Boolean(detail.letterId) && !detail.error;
  }
  if (!block.letterId) return false;
  if (block.role === "user") return block.fromBot !== undefined;
  return block.role === "system";
}

/** The letter a block marks, for deduping the call's row against the note it left. */
export function letterIdOf(block: Block): string | undefined {
  if (block.role === "tool") {
    const detail = block.tool?.detail;
    return detail?.kind === "message" ? detail.letterId : undefined;
  }
  return block.letterId;
}

/** A `send_message` Crew refused: the call failed, nothing was delivered. */
export function isRefused(block: Block): boolean {
  const detail = block.tool?.detail;
  return block.role === "tool" && detail?.kind === "message" && Boolean(detail.error);
}

/**
 * Who wrote to whom, read off the block in `owner`'s chat. `names` turns an
 * id the model used into the name the reader knows. Null for a block that is
 * not a letter, or a note whose words do not say.
 */
export function checkpointOf(block: Block, owner: Party, names: (idOrName: string) => string = (id) => id): Checkpoint | null {
  if (!isLetter(block)) return null;
  const at = block.at !== undefined ? { at: block.at } : {};
  if (block.role === "tool") {
    const detail = block.tool?.detail;
    if (detail?.kind !== "message" || !detail.letterId) return null;
    // Its kind is the session list's to say: a bot and a session are both reached by id.
    const to: Party = { id: detail.toId ?? "", name: detail.toName ?? names(detail.to) };
    return { letterId: detail.letterId, from: owner, to, ...at };
  }
  const letterId = block.letterId!;
  if (block.role === "user" && block.fromBot) return { letterId, from: partyOf(block.fromBot), to: owner, ...at };
  const started = STARTED.exec(block.text);
  if (started) {
    const name = started[1] ?? started[3]!;
    const id = started[2] ?? started[4]!;
    return { letterId, from: owner, to: { id, name, kind: "session" }, ...at };
  }
  const wrote = WROTE.exec(block.text);
  if (wrote) return { letterId, from: YOU, to: { id: "", name: wrote[1]!, kind: "session" }, ...at };
  return null;
}

/** What a refused send says: to whom, what, and why not. */
export function refusalOf(block: Block, names: (idOrName: string) => string = (id) => id): { to: string; text: string; reason: string } | null {
  const detail = block.tool?.detail;
  if (!isRefused(block) || detail?.kind !== "message") return null;
  return { to: detail.toName ?? names(detail.to), text: detail.text, reason: detail.error ?? "" };
}

/** One thread per pair, whoever wrote first: the key is the two ids, in order. */
export function pairKey(a: string, b: string): string {
  return [a || USER, b || USER].sort().join("|");
}

/** A pair to open, `focus` the letter to open it at. */
export type ThreadRef = { a: Party; b: Party; focus?: string };

/** A pair as the Conversations menu lists it, and as its thread opens: this chat's side first. */
export function pairThread(pair: ThreadPair, owner: Party): ThreadRef & { label: string; peer: Party } {
  const peer = partyOf(pair.peer);
  if (pair.with) {
    const other = partyOf(pair.with);
    return { a: peer, b: other, peer, label: `${peer.name} → ${other.name}` };
  }
  return { a: owner, b: peer, peer, label: peer.name };
}

/**
 * A thread's party whose id the block could not say (the child the user
 * wrote to, by name only): found among the owner's children by name.
 */
export function resolveParty(party: Party, sessions: readonly Session[], parentId: string): Party {
  if (party.id || party.kind === "user") return party;
  const child = sessions.find((session) => session.parentId === parentId && session.name === party.name);
  return child ? { ...party, id: child.id } : party;
}

/**
 * Letters waiting in a session's box, as the queued blocks the transcript
 * groups at its foot. One a turn already carries (`letterId` in the
 * transcript) is not waiting any more.
 */
export function queuedLetters(letters: readonly ThreadLetter[], blocks: readonly Block[]): Block[] {
  const shown = new Set(blocks.map(letterIdOf).filter((id): id is string => id !== undefined));
  return letters
    .filter((letter) => !shown.has(letter.id))
    .map((letter) => ({
      id: `queued-${letter.id}`,
      role: "user",
      text: letter.text,
      at: letter.at,
      streaming: true,
      letterId: letter.id,
      // The person's own letter is their bubble; anyone else's is a letter from them.
      ...(letter.from.kind === "user" ? {} : { fromBot: letter.from }),
    }));
}

/** Where a child stands, as its chip says it. */
export type ChildState = "working" | "reported" | "question" | "approval" | "failed" | "stopped" | "exited" | "starting";

/** A working status wins; otherwise its last event says what happened. */
export function childState(session: Pick<Session, "status" | "lastEvent">): ChildState {
  if (session.status === "working") return "working";
  if (session.status === "starting") return "starting";
  switch (session.lastEvent?.kind) {
    case "report":
      return "reported";
    case "question":
      return "question";
    case "approval":
      return "approval";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "exited":
      return "exited";
    default:
      return session.status === "error" ? "failed" : session.status === "exited" ? "exited" : "starting";
  }
}

/** A child is one its parent owns: started with `owner: "me"`, not handed to the user. */
export function isOwnedChild(session: Pick<Session, "kind" | "parentId" | "handedOffBy">): boolean {
  return session.kind === "child" && Boolean(session.parentId) && !session.handedOffBy;
}

/** The sessions each one started and owns, oldest first, by the starter's id. */
export function childrenOf(sessions: readonly Session[]): Map<string, Session[]> {
  const out = new Map<string, Session[]>();
  for (const session of [...sessions].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!isOwnedChild(session)) continue;
    const parent = session.parentId!;
    out.set(parent, [...(out.get(parent) ?? []), session]);
  }
  return out;
}

/** Something happened the user has not looked at: its cursor is past what they saw. */
export function unseen(session: Pick<Session, "cursor" | "userSeen">): boolean {
  return (session.cursor ?? 0) > (session.userSeen ?? 0);
}

/** A child failed and nobody has opened it since: its parent's row says so. */
export function failedUnseen(session: Pick<Session, "lastEvent" | "userSeen">): boolean {
  const event = session.lastEvent;
  return event?.kind === "failed" && event.cursor > (session.userSeen ?? 0);
}

/** A page read over what the thread holds: one copy of each letter, oldest first. */
export function mergeLetters(held: readonly ThreadLetter[], page: readonly ThreadLetter[]): ThreadLetter[] {
  const byId = new Map(held.map((letter) => [letter.id, letter]));
  for (const letter of page) byId.set(letter.id, letter);
  return [...byId.values()].sort((x, y) => x.at - y.at);
}

/**
 * Whose letters sit on the right of a thread, as the user's own messages do
 * in a chat: the chat owner's when it is one of the pair, else the user's.
 */
export function rightSide(thread: Pick<ThreadRef, "a" | "b">, owner: Party): string {
  return thread.a.id === owner.id || thread.b.id === owner.id ? owner.id : USER;
}

/** A letter's sender as a thread compares it: the person is `USER` whatever id it carries. */
export function senderId(letter: Pick<ThreadLetter, "from">): string {
  return partyOf(letter.from).id;
}
