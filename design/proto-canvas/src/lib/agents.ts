import { useMemo } from "react";
import {
  conversationBetween,
  conversations,
  graph,
  lineage,
  mailbox,
  rosterFrom,
  threads,
  type AgentGraph,
  type Conversation,
  type Letter,
  type LineageNode,
  type Roster,
  type Session,
} from "@crew/fixtures";

/**
 * Thin wrappers over the shared roster model. The prototype does not re-derive
 * who wrote to whom: `design/shared` already joins the outbound tool call and
 * the inbound turn into one letter with a delivery state, which is the whole
 * point of the agent-thread feature.
 */
export function useRoster(sessions: Session[]): Roster {
  return useMemo(() => rosterFrom(sessions, threads), [sessions]);
}

export function useConversations(roster: Roster): Conversation[] {
  return useMemo(() => conversations(roster), [roster]);
}

export function useGraph(roster: Roster): AgentGraph {
  return useMemo(() => graph(roster), [roster]);
}

export function useLineage(sessions: Session[]): LineageNode[] {
  return useMemo(() => lineage(sessions), [sessions]);
}

export function threadBetween(roster: Roster, a: string, b: string): Letter[] {
  return conversationBetween(roster, a, b)?.letters ?? [];
}

export function waitingFor(roster: Roster, sessionId: string): Letter[] {
  return mailbox(roster, sessionId);
}

/** Every agent this one has exchanged a letter with, newest first. */
export function peersOf(roster: Roster, sessionId: string) {
  return conversations(roster)
    .filter((entry) => entry.a.id === sessionId || entry.b.id === sessionId)
    .map((entry) => ({
      peer: entry.a.id === sessionId ? entry.b : entry.a,
      conversation: entry,
    }));
}
