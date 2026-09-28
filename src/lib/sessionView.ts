import { providerOf } from "./providers";
import type { Session } from "./types";

/** Where a session's conversation is shown: its CLI's own screen, or Crew's chat drawn over it. */
export const SESSION_VIEWS = [
  { id: "terminal", label: "Terminal" },
  { id: "chat", label: "Chat" },
] as const;

export type SessionView = (typeof SESSION_VIEWS)[number]["id"];

export const DEFAULT_SESSION_VIEW: SessionView = "terminal";

export const SESSION_VIEW_KEY = "sessions:view";

export function parseSessionView(raw: string | null | undefined): SessionView {
  return SESSION_VIEWS.some((view) => view.id === raw) ? (raw as SessionView) : DEFAULT_SESSION_VIEW;
}

/** What fills a session's tab. */
export type SessionSurface = "agent" | "chat" | "terminal";

/**
 * Which view a session uses. An agent is always its chat. A session shows the
 * chat when the setting asks for it and Crew can read its CLI's history;
 * anything else is its terminal.
 */
export function sessionSurface(session: Pick<Session, "kind" | "provider">, view: SessionView): SessionSurface {
  if (session.kind === "agent") return "agent";
  return view === "chat" && providerOf(session.provider)?.chat ? "chat" : "terminal";
}

/** CLIs whose hooks Crew passes on each launch, so the daemon hears what they do. */
export function reportsLive(provider: string): boolean {
  return provider === "claude";
}
