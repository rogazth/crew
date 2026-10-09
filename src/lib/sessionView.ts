import type { Session, SessionView } from "./types";

export type { SessionView };

/** Where a new session opens: its CLI's own screen, or Crew's chat, which drives the CLI. */
export const SESSION_VIEWS: readonly { id: SessionView; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "chat", label: "Chat" },
];

export const DEFAULT_SESSION_VIEW: SessionView = "terminal";

/** The default for sessions created from now on; a session keeps the view it was created with. */
export const SESSION_VIEW_KEY = "sessions:view";

export function parseSessionView(raw: string | null | undefined): SessionView {
  return SESSION_VIEWS.some((view) => view.id === raw) ? (raw as SessionView) : DEFAULT_SESSION_VIEW;
}

/** What fills a session's tab. */
export type SessionSurface = "turns" | "terminal";

/**
 * Which view a session uses. A bot is always its chat, and so is a child:
 * Crew drives both turn by turn, so there is no terminal to show. A terminal
 * session has the view its row says, fixed when it was created: the chat
 * (Crew drives its CLI like a child's) or the CLI's own screen.
 */
export function sessionSurface(session: Pick<Session, "kind" | "view">): SessionSurface {
  return session.kind === "terminal" && session.view !== "chat" ? "terminal" : "turns";
}

/** CLIs whose hooks Crew passes on each launch, so the daemon hears what they do. */
export function reportsLive(provider: string): boolean {
  return provider === "claude" || provider === "codex";
}
