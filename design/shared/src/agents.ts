/**
 * The agent network: who wrote to whom, who created whom, and what is still
 * waiting in a box.
 *
 * The daemon already models all of this — `mailbox.rs` is a real table with a
 * `delivered_at` column — but the renderer shows none of it. A letter appears
 * twice, in two transcripts, as two unrelated rows: an outbound `message_agent`
 * tool call in the sender's, and an inbound `role=user` turn in the receiver's.
 * Nothing joins them, so "the conversation between two agents" is not a thing
 * the UI can show, and "three letters are queued for a busy agent" is not a
 * thing it can say.
 *
 * This module joins them. It is the model the three prototypes render.
 */
import type { AgentRef, Block, Session } from "./types";
import { detailOf } from "./toolDetail";
import { crewTool, innerToolFromTitle } from "./crewTools";

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type LetterState = "waiting" | "delivered" | "read";

export type Letter = {
  id: string;
  /** Who wrote it. */
  from: AgentRef;
  /** Who it was written to. */
  to: AgentRef;
  text: string;
  at: number;
  state: LetterState;
  /** The block in the sender's transcript, when we have it. */
  sentBlockId?: string;
  /** The block in the receiver's transcript, when it has been delivered. */
  receivedBlockId?: string;
};

export type Conversation = {
  a: AgentRef;
  b: AgentRef;
  letters: Letter[];
  lastAt: number;
  /** Letters still sitting in a box, from either side. */
  waiting: number;
};

export type Edge = {
  from: AgentRef;
  to: AgentRef;
  count: number;
  lastAt: number;
  waiting: number;
};

export type AgentGraph = {
  nodes: Array<{ agent: AgentRef; sent: number; received: number; waiting: number }>;
  edges: Edge[];
  conversations: Conversation[];
};

export type Roster = {
  /** Every session that can hold a conversation, by id. */
  agents: Map<string, AgentRef>;
  /** Transcript per session id. */
  threads: Map<string, Block[]>;
};

export function rosterFrom(sessions: Session[], threads: Record<string, Block[]>): Roster {
  const agents = new Map<string, AgentRef>();
  for (const session of sessions) {
    if (session.kind !== "agent") continue;
    agents.set(session.id, { id: session.id, name: session.name });
  }
  return { agents, threads: new Map(Object.entries(threads)) };
}

const nameOf = (roster: Roster, id: string) => roster.agents.get(id)?.name ?? id;
const refOf = (roster: Roster, id: string): AgentRef => ({ id, name: nameOf(roster, id) });

/** The id behind a display name, for the one path that only has the name. */
function idFor(roster: Roster, name: string): string {
  if (roster.agents.has(name)) return name;
  for (const [id, ref] of roster.agents) if (ref.name === name) return id;
  return name;
}

/**
 * How far after a send its twin may land. A letter waits in the box while the
 * target finishes whatever it was doing, and an agent can be mid-turn for a long
 * time, so this is generous on purpose — the text has to match as well.
 */
const PAIR_WINDOW_MS = 48 * 60 * 60_000;
/** Clock skew between two transcripts written by two processes. */
const PAIR_SLACK_MS = 60_000;

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Enough of a letter to identify it, short enough to survive an envelope header. */
function fingerprint(text: string): string {
  return normalise(text).slice(0, 60);
}

/**
 * Every letter in the workspace, each one counted once.
 *
 * A letter exists as an outbound tool call in the sender's transcript and, once
 * delivered, as an inbound turn in the receiver's. Pairing them is what turns
 * two half-rows into one fact with a delivery state: an outbound with no twin is
 * still `waiting`, a pair is `delivered`.
 */
export function letters(roster: Roster): Letter[] {
  type Half = {
    peerId: string;
    selfId: string;
    text: string;
    at: number;
    blockId: string;
    /**
     * The name the block carried. A sender deleted since has no row in the
     * roster, and `mailbox.rs` copies its name in at send time precisely so the
     * transcript can still say who wrote — so the block outranks the roster here.
     */
    peerName?: string;
  };
  const outbound: Half[] = [];
  const inbound: Half[] = [];

  for (const [sessionId, blocks] of roster.threads) {
    blocks.forEach((block) => {
      if (block.fromAgent) {
        inbound.push({
          peerId: block.fromAgent.id,
          selfId: sessionId,
          text: block.text,
          at: block.at ?? 0,
          blockId: block.id,
          ...(block.fromAgent.name ? { peerName: block.fromAgent.name } : {}),
        });
        return;
      }
      const detail = detailOf(block);
      if (detail?.kind === "message") {
        outbound.push({
          peerId: detail.to,
          selfId: sessionId,
          text: detail.text,
          at: block.at ?? 0,
          blockId: block.id,
        });
        return;
      }
      // A letter the adapter failed to normalise. Two shapes, both measured
      // against a real daemon: a direct `message_agent` call whose arguments we
      // hold, and one routed through `call_tool`, where only the result — which
      // names the target and the depth of its box — survives.
      const outer = crewTool(block.tool?.name ?? "");
      const title = block.tool?.title ?? "";
      const isLetter =
        outer === "message_agent" ||
        (outer === "call_tool" && innerToolFromTitle(title) === "message_agent");
      if (!isLetter) return;

      const args = block.tool?.args ?? {};
      const argTo = typeof args["to"] === "string" ? (args["to"] as string) : null;
      if (argTo) {
        outbound.push({
          peerId: argTo,
          selfId: sessionId,
          text: typeof args["text"] === "string" ? (args["text"] as string) : "",
          at: block.at ?? 0,
          blockId: block.id,
        });
        return;
      }
      if (detail?.kind !== "output") return;
      const result = parseJson(detail.text);
      const to = typeof result?.["to"] === "string" ? (result["to"] as string) : null;
      if (!to) return;
      outbound.push({
        // The result names the target rather than addressing it, so this is a
        // name where every other path has an id. `idFor` puts that right.
        peerId: idFor(roster, to),
        selfId: sessionId,
        text: "",
        at: block.at ?? 0,
        blockId: block.id,
      });
    });
  }

  const unmatched = [...inbound];
  const out: Letter[] = [];

  // Oldest first, so when two identical letters went to the same agent the first
  // send claims the first delivery.
  outbound.sort((a, b) => a.at - b.at);

  for (const sent of outbound) {
    const mark = fingerprint(sent.text);
    // The receiver's copy carries an envelope header above the body, so the
    // inbound text contains the outbound one rather than equalling it. A letter
    // the gateway stripped has no body to match on, so it falls back to the
    // nearest delivery from that peer — the best available guess, and why the
    // window below is bounded in both directions.
    let best = -1;
    let bestGap = Infinity;
    unmatched.forEach((got, index) => {
      if (got.peerId !== sent.selfId || got.selfId !== sent.peerId) return;
      const gap = got.at - sent.at;
      // A letter cannot be delivered before it was written, give or take skew.
      if (gap < -PAIR_SLACK_MS || gap > PAIR_WINDOW_MS) return;
      if (mark && !normalise(got.text).includes(mark)) return;
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    const twin = best >= 0 ? unmatched.splice(best, 1)[0] : undefined;
    out.push({
      id: sent.blockId,
      from: refOf(roster, sent.selfId),
      to: refOf(roster, sent.peerId),
      // A letter routed through `call_tool` reaches the sender's transcript with
      // no body — the gateway's result names the target and nothing else. The
      // receiver's copy has the words, so a paired letter borrows them.
      text: sent.text || twin?.text || "",
      at: sent.at,
      state: twin ? "delivered" : "waiting",
      sentBlockId: sent.blockId,
      ...(twin ? { receivedBlockId: twin.blockId } : {}),
    });
  }

  // An inbound with no outbound twin is a letter whose sender's transcript we do
  // not hold — a deleted agent, or a window that only loaded part of the world.
  for (const got of unmatched) {
    out.push({
      id: got.blockId,
      from: got.peerName ? { id: got.peerId, name: got.peerName } : refOf(roster, got.peerId),
      to: refOf(roster, got.selfId),
      text: got.text,
      at: got.at,
      state: "delivered",
      receivedBlockId: got.blockId,
    });
  }

  out.sort((a, b) => a.at - b.at);
  return out;
}

const pairKey = (a: string, b: string) => [a, b].sort().join("::");

/** Every two-agent conversation in the workspace, newest activity first. */
export function conversations(roster: Roster): Conversation[] {
  const byPair = new Map<string, Conversation>();
  for (const letter of letters(roster)) {
    const key = pairKey(letter.from.id, letter.to.id);
    let held = byPair.get(key);
    if (!held) {
      // Stable orientation: whichever id sorts first is `a`, so the same pair
      // always reads the same way whichever transcript you came from.
      const [first] = [letter.from.id, letter.to.id].sort();
      const a = first === letter.from.id ? letter.from : letter.to;
      const b = first === letter.from.id ? letter.to : letter.from;
      held = { a, b, letters: [], lastAt: 0, waiting: 0 };
      byPair.set(key, held);
    }
    held.letters.push(letter);
    held.lastAt = Math.max(held.lastAt, letter.at);
    if (letter.state === "waiting") held.waiting += 1;
  }
  return [...byPair.values()].sort((x, y) => y.lastAt - x.lastAt);
}

/** The conversation between two agents, or null when they have never written. */
export function conversationBetween(
  roster: Roster,
  aId: string,
  bId: string,
): Conversation | null {
  const key = pairKey(aId, bId);
  return conversations(roster).find((c) => pairKey(c.a.id, c.b.id) === key) ?? null;
}

/** Every conversation one agent is part of. */
export function conversationsFor(roster: Roster, sessionId: string): Conversation[] {
  return conversations(roster).filter((c) => c.a.id === sessionId || c.b.id === sessionId);
}

/** What is still queued for an agent, oldest first — the daemon's `waiting()`. */
export function mailbox(roster: Roster, sessionId: string): Letter[] {
  return letters(roster)
    .filter((letter) => letter.to.id === sessionId && letter.state === "waiting")
    .sort((a, b) => a.at - b.at);
}

export function graph(roster: Roster): AgentGraph {
  const all = letters(roster);
  const nodes = new Map<string, { agent: AgentRef; sent: number; received: number; waiting: number }>();
  const edges = new Map<string, Edge>();

  const node = (ref: AgentRef) => {
    let held = nodes.get(ref.id);
    if (!held) {
      held = { agent: ref, sent: 0, received: 0, waiting: 0 };
      nodes.set(ref.id, held);
    }
    return held;
  };

  for (const ref of roster.agents.values()) node(ref);

  for (const letter of all) {
    node(letter.from).sent += 1;
    const target = node(letter.to);
    target.received += 1;
    if (letter.state === "waiting") target.waiting += 1;

    const key = `${letter.from.id}→${letter.to.id}`;
    const edge = edges.get(key) ?? {
      from: letter.from,
      to: letter.to,
      count: 0,
      lastAt: 0,
      waiting: 0,
    };
    edge.count += 1;
    edge.lastAt = Math.max(edge.lastAt, letter.at);
    if (letter.state === "waiting") edge.waiting += 1;
    edges.set(key, edge);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received)),
    edges: [...edges.values()].sort((a, b) => b.count - a.count),
    conversations: conversations(roster),
  };
}

// ---------------------------------------------------------------------------
// Lineage — who created whom
// ---------------------------------------------------------------------------

export type LineageNode = {
  session: Session;
  children: LineageNode[];
  /** How deep in the tree; roots are 0. */
  depth: number;
};

/**
 * The creation tree. An agent that `create_agent`s another is its parent, which
 * the store already records as `created_by`; the UI has never drawn it, so a
 * workspace of twelve agents reads as a flat list with no history.
 */
export function lineage(sessions: Session[]): LineageNode[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const childrenOf = new Map<string, Session[]>();
  const roots: Session[] = [];

  for (const session of sessions) {
    if (session.kind !== "agent") continue;
    const parentId = session.createdBy?.id;
    if (parentId && byId.has(parentId) && parentId !== session.id) {
      const held = childrenOf.get(parentId) ?? [];
      held.push(session);
      childrenOf.set(parentId, held);
    } else {
      roots.push(session);
    }
  }

  const seen = new Set<string>();
  const build = (session: Session, depth: number): LineageNode => {
    // A cycle would be a store bug, not a UI case — but a UI that recurses
    // forever on one is a worse bug.
    seen.add(session.id);
    const kids = (childrenOf.get(session.id) ?? []).filter((child) => !seen.has(child.id));
    return {
      session,
      depth,
      children: kids
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((child) => build(child, depth + 1)),
    };
  };

  return roots.sort((a, b) => a.createdAt - b.createdAt).map((root) => build(root, 0));
}

/** The lineage tree flattened for a list that indents by depth. */
export function flattenLineage(nodes: LineageNode[]): LineageNode[] {
  const out: LineageNode[] = [];
  const walk = (node: LineageNode) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** "Created by Relay · 9 days ago" — the attribution row, as a first-class fact. */
export function attribution(session: Session): { by: AgentRef; at: number } | null {
  return session.createdBy ? { by: session.createdBy, at: session.createdAt } : null;
}
