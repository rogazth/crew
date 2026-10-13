import { isOwnedChild } from "./letters";
import type { Session } from "./types";

/**
 * Where a session opens. An owned subagent never has a tab: it opens inside
 * its parent's, as a thread. `root` is the session whose tab shows it (the
 * top of the chain of owners), `links` the thread to open at each level, outermost first.
 * Null when the session has its own tab (an independent session, or a child whose parent is gone).
 */
export type AgentRoute = { root: Session; links: { parentId: string; childId: string }[] };

export function routeAgent(session: Session, sessions: readonly Session[]): AgentRoute | null {
  const byId = new Map(sessions.map((row) => [row.id, row]));
  const links: AgentRoute["links"] = [];
  let at = session;
  const seen = new Set([at.id]);
  while (isOwnedChild(at)) {
    const parent = byId.get(at.parentId!);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    links.unshift({ parentId: parent.id, childId: at.id });
    at = parent;
  }
  return links.length === 0 ? null : { root: at, links };
}

export type AgentRequest = { childId: string; focus?: string };

const waiting = new Map<string, AgentRequest>();
const listeners = new Set<() => void>();

/** Asks the chat of `parentId` to open `childId`'s thread; it does when it shows, or at once if it already does. */
export function requestAgent(parentId: string, request: AgentRequest) {
  waiting.set(parentId, request);
  for (const listener of [...listeners]) listener();
}

/** The request waiting for a chat, left in place. */
export function peekAgentRequest(parentId: string): AgentRequest | undefined {
  return waiting.get(parentId);
}

/** Takes the request waiting for a chat, once. */
export function takeAgentRequest(parentId: string): AgentRequest | undefined {
  const request = waiting.get(parentId);
  waiting.delete(parentId);
  return request;
}

export function onAgentRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Queues every level of a route; the last one carries the letter to land on. */
export function requestRoute(route: AgentRoute, focus?: string) {
  route.links.forEach((link, index) =>
    requestAgent(link.parentId, { childId: link.childId, ...(focus && index === route.links.length - 1 ? { focus } : {}) }),
  );
}
