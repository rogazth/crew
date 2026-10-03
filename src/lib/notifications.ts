import { notify } from "./host";
import { BODY_LIMIT, type NotificationTarget } from "./notify";
import type { Session, SessionStatus } from "./types";

/** What a notification is news of; each has its own switch in Settings. */
export type NotificationSource = "done" | "needs-input" | "error" | "bell" | "connection" | "test";

export type NotificationEvent = {
  source: NotificationSource;
  title: string;
  body: string;
  /** The session it is about: a click opens it, and it stays quiet while the user looks at it. */
  session?: { id: string; workspaceId: string; notifications: boolean } | undefined;
  /** What counts as the same news for the cooldown. Defaults to the session, else the title. */
  key?: string;
};

/** Why a notification was not shown. */
export type SkipReason =
  /** The session's own switch is off. */
  | "muted"
  /** The window is focused on the very session it is about. */
  | "suppressed-focus"
  /** The same news went out moments ago. */
  | "cooldown"
  /** macOS has notifications off for Crew. */
  | "blocked"
  | "unsupported";

export type DispatchResult = { delivered: true } | { delivered: false; reason: SkipReason };

/**
 * One burst is one notification: a CLI that rings, then stops to ask, then
 * rings again says the same thing three times in a second.
 */
export const COOLDOWN_MS = 5000;
const COOLDOWN_KEYS = 50;

/** The session whose tab is on screen, when no page covers it. */
let visible: string | null = null;
const recent = new Map<string, number>();

export function setVisibleSession(id: string | null): void {
  visible = id;
}

/**
 * Claims `key` for the next {@link COOLDOWN_MS}; false while an earlier claim
 * holds. Old keys are dropped so the map stays small.
 */
export function reserveCooldown(seen: Map<string, number>, key: string, now: number): boolean {
  const last = seen.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return false;
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > COOLDOWN_KEYS) {
    for (const [old, at] of seen) if (now - at >= COOLDOWN_MS) seen.delete(old);
    while (seen.size > COOLDOWN_KEYS) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }
  return true;
}

function cooldownKey(event: NotificationEvent): string {
  return event.key ?? event.session?.id ?? `${event.source}:${event.title}`;
}

function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/**
 * Every notification goes through here: it is shown, or the answer says why
 * not. The test button skips the cooldown, since pressing it twice means it.
 */
export async function dispatchNotification(event: NotificationEvent): Promise<DispatchResult> {
  const { session } = event;
  if (session && !session.notifications) return skip("muted");
  if (session && session.id === visible && windowFocused()) return skip("suppressed-focus");
  if (event.source !== "test" && !reserveCooldown(recent, cooldownKey(event), Date.now())) return skip("cooldown");
  const target: NotificationTarget | null = session ? { workspaceId: session.workspaceId, sessionId: session.id } : null;
  try {
    const result = await notify({ title: event.title, body: event.body.slice(0, BODY_LIMIT), target });
    return result === "shown" ? { delivered: true } : skip(result);
  } catch {
    // The banner is a courtesy; the transcript already has the news.
    return skip("unsupported");
  }
}

function skip(reason: SkipReason): DispatchResult {
  return { delivered: false, reason };
}

type Announced = Pick<Session, "id" | "workspaceId" | "name" | "notifications">;

/** News of a session, under its name; a click on it opens the session. */
export function announceSession(session: Announced, source: NotificationSource, body: string): void {
  void dispatchNotification({
    source,
    title: session.name,
    body,
    session: { id: session.id, workspaceId: session.workspaceId, notifications: session.notifications },
  });
}

/** What a terminal session's status is news of, read off its process: there is no reply to quote. */
const TERMINAL_NEWS: Partial<Record<SessionStatus, [NotificationSource, string]>> = {
  "needs-input": ["needs-input", "Needs your input"],
  done: ["done", "Finished"],
  error: ["error", "Exited with an error"],
};

export function announceStatus(session: Announced, status: SessionStatus): void {
  const news = TERMINAL_NEWS[status];
  if (news) announceSession(session, news[0], news[1]);
}

/** Forgets what went out, for tests. */
export function resetNotifications(): void {
  recent.clear();
  visible = null;
}
