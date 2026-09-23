import type { Session, Tab } from "./types";

/** The same key that opened a palette mode closes it; another mode switches to it. */
export function togglePaletteMode<M>(open: M | null, mode: M): M | null {
  return open === mode ? null : mode;
}

export function activeSessionIdOf(tab: Tab | null): string | null {
  return tab?.kind === "session" ? tab.sessionId : null;
}

export function withModel(session: Session, provider: string, model: string): Session {
  return { ...session, provider, model };
}

/**
 * A workspace's panes go first: dropping them is what stops the terminals it
 * was running. Then its sessions, then the row itself.
 */
export async function removeWorkspaceInOrder(
  id: string,
  steps: {
    forgetTabs: (id: string) => void;
    forgetSessions: (id: string) => void;
    deleteWorkspace: (id: string) => Promise<void>;
  },
): Promise<void> {
  steps.forgetTabs(id);
  steps.forgetSessions(id);
  await steps.deleteWorkspace(id);
}
