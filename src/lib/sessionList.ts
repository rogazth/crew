import type { Session } from "./types";

/**
 * A row the daemon says changed, over the one on screen: the bot's own
 * rewrite of its description, a terminal that moved to a new conversation.
 * Its status stays the window's to report, but for the unread the daemon
 * handed to the conversation it left.
 */
export function applyUpdated(held: Session, row: Session): Session {
  return {
    ...held,
    name: row.name,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    serviceTier: row.serviceTier ?? "",
    autonomy: row.autonomy,
    description: row.description,
    providerSessionId: row.providerSessionId,
    status: held.status === "done" ? row.status : held.status,
    // Where it got and what the user read of it: a child's chip, a handoff's unread dot.
    ...(row.cursor !== undefined ? { cursor: row.cursor } : {}),
    ...(row.userSeen !== undefined ? { userSeen: row.userSeen } : {}),
    ...(row.lastEvent ? { lastEvent: row.lastEvent } : {}),
    ...(row.parentName !== undefined ? { parentName: row.parentName } : {}),
    ...(row.launchedByName !== undefined ? { launchedByName: row.launchedByName } : {}),
    ...(row.paused !== undefined ? { paused: row.paused } : {}),
  };
}
