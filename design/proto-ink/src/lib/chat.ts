import { useEffect, useMemo, useState } from "react";
import {
  CREW_TOOLS,
  crewTool,
  crewToolLine,
  letters,
  mailbox,
  phaseLabel,
  rosterFrom,
  sessions as FIXTURE_SESSIONS,
  threads as FIXTURE_THREADS,
} from "@crew/fixtures";
import type {
  Block,
  CrewToolKind,
  CrewToolLine,
  Letter,
  Phase,
  Roster,
  Session,
  ThreadState,
} from "@crew/fixtures";
import type { IconName } from "./icon";
import { threadOf } from "./source";

/**
 * `subscribe` calls back synchronously before it returns, so the state is
 * already current by the time the effect finishes — no first-paint flash, and
 * nothing to hold in a box because the listener never unsubscribes itself.
 */
export function useThread(sessionId: string) {
  const handle = useMemo(() => threadOf(sessionId), [sessionId]);
  const [state, setState] = useState<ThreadState>(() => handle.snapshot());
  useEffect(() => handle.subscribe(setState), [handle]);
  return { ...state, runtime: handle };
}

/** Agent ids are the wire currency; names are what a reader wants. */
export function agentName(id: string, sessions: Array<{ id: string; name: string }>): string {
  return (
    sessions.find((s) => s.id === id)?.name ??
    FIXTURE_SESSIONS.find((s) => s.id === id)?.name ??
    id
  );
}

export type LetterIndex = {
  roster: Roster;
  /**
   * The letter a sent block stands for, with its text resolved. A letter routed
   * through the tool gateway loses its body on the way out — only the receiver's
   * copy has it — so the text comes from whichever half kept it.
   */
  bySentBlock: Map<string, Letter>;
};

/**
 * Pairing both halves of every letter in the workspace is a whole-roster
 * operation, so it happens once per session list rather than once per
 * transcript. `letters()` is what recovers a letter's text when the sender's
 * own row lost it — which is what happens whenever a provider reaches
 * `message_agent` through the tool gateway.
 */
export function useLetterIndex(sessions: Session[]): LetterIndex {
  return useMemo(() => {
    const roster = rosterFrom(sessions, FIXTURE_THREADS);
    const byId = new Map<string, Block>();
    for (const thread of Object.values(FIXTURE_THREADS)) {
      for (const block of thread) byId.set(block.id, block);
    }
    const bySentBlock = new Map<string, Letter>();
    for (const letter of letters(roster)) {
      if (!letter.sentBlockId) continue;
      const received = letter.receivedBlockId ? byId.get(letter.receivedBlockId) : undefined;
      bySentBlock.set(letter.sentBlockId, {
        ...letter,
        text: letter.text || received?.text || "",
      });
    }
    return { roster, bySentBlock };
  }, [sessions]);
}

export const mailboxOf = (index: LetterIndex, sessionId: string): Letter[] =>
  mailbox(index.roster, sessionId);

export function crewLineOf(
  block: Block,
  resolve?: (id: string) => string,
): CrewToolLine | null {
  const detail = block.tool?.detail;
  return crewToolLine(block.tool?.name ?? "", block.tool?.args, resolve, {
    ...(block.tool?.title ? { title: block.tool.title } : {}),
    ...(detail?.kind === "output" ? { output: detail.text } : {}),
  });
}

/**
 * Give every outbound letter the `message` detail the daemon did not send, so
 * `groupRows` can join it with the inbound half instead of leaving it stranded
 * among the tool calls. Two sources, in order: the paired letter (which knows
 * the text even when the sender's row lost it), then the call's own arguments.
 *
 * A letter with no twin has not been delivered, so its id lands in `waiting`.
 */
export function normaliseLetters(
  blocks: Block[],
  index: LetterIndex,
): { blocks: Block[]; waiting: Set<string> } {
  const waiting = new Set<string>();
  let changed = false;

  const next = blocks.map((block) => {
    if (block.tool?.detail?.kind === "message" || !block.tool) return block;

    const paired = index.bySentBlock.get(block.id);
    if (paired) {
      if (paired.state === "waiting") waiting.add(block.id);
      if (!paired.text) return block;
      changed = true;
      return {
        ...block,
        tool: { ...block.tool, detail: { kind: "message" as const, to: paired.to.id, text: paired.text } },
      };
    }

    if (block.tool.detail || crewTool(block.tool.name) !== "message_agent") return block;
    const to = block.tool.args?.["to"];
    const text = block.tool.args?.["text"];
    if (typeof to !== "string" || typeof text !== "string") return block;
    changed = true;
    waiting.add(block.id);
    return { ...block, tool: { ...block.tool, detail: { kind: "message" as const, to, text } } };
  });

  return { blocks: changed ? next : blocks, waiting };
}

const CREW_GLYPH: Record<CrewToolKind, IconName> = {
  agent: "bot",
  message: "mail",
  routine: "routine",
  self: "wand",
  search: "search",
  gateway: "package",
};

export type RowGlyph = { icon: IconName; crew: boolean };

/** What a tool row wears: what it did, not what its phase was called. */
export function glyphFor(block: Block, resolve?: (id: string) => string): RowGlyph {
  const detail = block.tool?.detail;
  if (detail?.kind === "message") return { icon: "mail", crew: false };
  const crew = crewLineOf(block, resolve);
  if (crew) return { icon: CREW_GLYPH[crew.kind], crew: true };
  switch (detail?.kind) {
    case "command":
      return { icon: "terminal", crew: false };
    case "file":
      return { icon: "fileCode", crew: false };
    case "edit":
      return { icon: "edit", crew: false };
    case "search":
      return { icon: "search", crew: false };
    case "fetch":
      return { icon: "globe", crew: false };
    case "output":
      return { icon: "text", crew: false };
    default:
      return { icon: "wrench", crew: false };
  }
}

/**
 * `phaseLabel` has no opinion about Crew's own tools, so a run of them folds to
 * "Ran 3 tools" — the least informative line available for the most interesting
 * calls an agent makes. When a phase is all one kind of Crew work, say so.
 */
export function phaseLabelOf(phase: Phase): string {
  if (phase.kind !== "other") return phaseLabel(phase);
  const kinds = new Set<CrewToolKind>();
  for (const block of phase.blocks) {
    const tool = crewTool(block.tool?.name ?? "");
    if (!tool) return phaseLabel(phase);
    kinds.add(CREW_TOOLS[tool].kind);
  }
  if (kinds.size !== 1) return `Ran ${phase.blocks.length} Crew tools`;
  const count = phase.blocks.length;
  const kind = [...kinds][0];
  switch (kind) {
    case "agent":
      return count === 1 ? "Worked on the roster" : `Worked on the roster · ${count} calls`;
    case "message":
      return count === 1 ? "Wrote to an agent" : `Wrote ${count} letters`;
    case "routine":
      return count === 1 ? "Changed a routine" : `Changed ${count} routines`;
    case "self":
      return count === 1 ? "Rewrote its own orders" : `Rewrote its own orders · ${count} calls`;
    case "search":
      return "Searched its own history";
    case "gateway":
      return count === 1 ? "Used the tool gateway" : `Used the tool gateway ${count} times`;
    default:
      return phaseLabel(phase);
  }
}

/** The line the daemon writes into a spawned agent's transcript. */
export const CREATED_BY_NOTE = /^created by\s+/i;

/**
 * A row that changed the world rather than looked at it. Folding is for rows
 * that are interchangeable with each other; creating an agent is not
 * interchangeable with anything, and burying it behind "Ran 4 tools" is how the
 * single most consequential call an agent makes became the least readable.
 */
export function isConsequential(block: Block): boolean {
  const tool = crewTool(block.tool?.name ?? "");
  if (!tool) return false;
  if (tool === "create_agent" || tool === "message_agent") return true;
  if (tool !== "call_tool") return false;
  const crew = crewLineOf(block);
  return crew?.kind === "agent" || crew?.kind === "message";
}
