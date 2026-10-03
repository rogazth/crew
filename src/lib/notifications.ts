import { notify } from "./host";
import {
  isPaused,
  loadNotificationPrefs,
  notificationPrefs,
  type KindPrefs,
  type NotificationKind,
} from "./notificationPrefs";
import { playSound } from "./notificationSound";
import { BODY_LIMIT, type NotificationTarget } from "./notify";
import { showToast } from "./toasts";
import type { SessionAsk } from "./protocol";
import type { Session, SessionStatus } from "./types";

/** What a notification is news of; each kind has its own switch in Settings. `test` is the button there. */
export type NotificationSource = NotificationKind | "test";

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
  /** Notifications are off altogether. */
  | "disabled"
  /** Do not disturb is on. */
  | "paused"
  /** This kind has no banner and no sound. */
  | "source-disabled"
  /** The session's own switch is off. */
  | "muted"
  /** The window is focused on the very session it is about, or in front with banners and sound off. */
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
const PREFS_WAIT_MS = 1000;
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
 * Every notification goes through here: it is shown, played, or the answer
 * says why not. The test button skips the switches and the cooldown, since
 * pressing it means it; it sounds like a session waiting on the user.
 */
export async function dispatchNotification(event: NotificationEvent): Promise<DispatchResult> {
  // The saved prefs, if the daemon answers in time; news does not wait on a socket.
  await Promise.race([loadNotificationPrefs(), new Promise((resolve) => setTimeout(resolve, PREFS_WAIT_MS))]);
  const prefs = notificationPrefs();
  const test = event.source === "test";
  const kind: KindPrefs = event.source === "test" ? { ...prefs.kinds["needs-input"], banner: true } : prefs.kinds[event.source];
  if (!test) {
    if (!prefs.enabled) return skip("disabled");
    if (isPaused(prefs, Date.now())) return skip("paused");
    if (!kind.banner && kind.sound === "none") return skip("source-disabled");
  }
  const { session } = event;
  if (session && !session.notifications) return skip("muted");
  const focused = windowFocused();
  if (session && session.id === visible && focused) return skip("suppressed-focus");
  if (!test && !reserveCooldown(recent, cooldownKey(event), Date.now())) return skip("cooldown");

  const target: NotificationTarget | null = session ? { workspaceId: session.workspaceId, sessionId: session.id } : null;
  const banner = kind.banner && (test || !(prefs.onlyWhenUnfocused && focused));
  // In front, the window says it itself, where a banner would have.
  const toast = kind.banner && !banner && focused && prefs.toasts;
  // The OS's own sound rides on the banner; with no banner the window plays it.
  if (kind.sound !== "system" || !banner) void playSound(kind.sound, prefs.volume, prefs.customSound);
  if (toast) showToast({ title: event.title, body: event.body, source: event.source, target });
  if (!banner) return kind.sound === "none" && !toast ? skip("suppressed-focus") : { delivered: true };

  try {
    const result = await notify({
      title: event.title,
      body: event.body.slice(0, BODY_LIMIT),
      target,
      silent: kind.sound !== "system",
    });
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

/**
 * Only a turn that ran is finished: a CLI that was idle and goes (its daemon
 * restarted, the user quit it) ends `done` too, and that is no news.
 */
export function announceStatus(session: Announced, status: SessionStatus, prev: SessionStatus): void {
  if (status === prev) return;
  if (status === "done" && prev !== "working" && prev !== "needs-input") return;
  const news = TERMINAL_NEWS[status];
  if (news) announceSession(session, news[0], news[1]);
}

/** What a CLI's hooks say it stopped on: a question form, or a permission prompt for a tool. */
export function askNews(ask: SessionAsk): [NotificationSource, string] {
  const question = ask.questions[0]?.question;
  if (question) return ["needs-input", `Asks: ${question}`];
  const input = ask.input;
  const what = [input.command, input.file_path, input.path, input.url].find((value) => typeof value === "string" && value);
  return ["approval", what ? `Wants to run ${ask.tool}: ${String(what)}` : `Wants to use ${ask.tool}`];
}

/** Forgets what went out, for tests. */
export function resetNotifications(): void {
  recent.clear();
  visible = null;
}
