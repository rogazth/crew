import { dismissNotifications, notificationStatus, notify } from "./host";
import {
  isPaused,
  loadNotificationPrefs,
  notificationPrefs,
  type KindPrefs,
  type NotificationKind,
} from "./notificationPrefs";
import { playSound } from "./notificationSound";
import { BODY_LIMIT, type NotificationTarget } from "./notify";
import { showToast, toastManager } from "./toasts";
import type { Session } from "./types";

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
  /** This kind is off. */
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
  markSeen();
}

/**
 * The session on screen in a focused window has been seen: its banners and
 * toast come down instead of piling up in Notification Center.
 */
export function markSeen(): void {
  if (!visible || !windowFocused()) return;
  dismissNotifications(visible);
  toastManager.close(`session:${visible}`);
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
  const kind: KindPrefs = event.source === "test" ? prefs.kinds["needs-input"] : prefs.kinds[event.source];
  if (!test) {
    if (!prefs.enabled) return skip("disabled");
    if (isPaused(prefs, Date.now())) return skip("paused");
    if (!kind.enabled) return skip("source-disabled");
  }
  const { session } = event;
  if (session && !session.notifications) return skip("muted");
  const focused = windowFocused();
  if (session && session.id === visible && focused) return skip("suppressed-focus");
  if (!test && !reserveCooldown(recent, cooldownKey(event), Date.now())) return skip("cooldown");

  const target: NotificationTarget | null = session ? { workspaceId: session.workspaceId, sessionId: session.id } : null;
  // Banners are for Crew in the background; in front, a sound and a toast are enough.
  const banner = test || !focused;
  // In front, the window says it itself, where a banner would have.
  const toast = !banner && prefs.toasts;
  if (toast) showToast({ title: event.title, body: event.body, source: event.source, target });
  if (!banner) {
    // No banner to answer for macOS: its last word on notifications decides the sound.
    const blocked = (await notificationStatus().catch(() => "unknown")) === "blocked";
    if (!blocked) void playSound(kind.sound, prefs.volume);
    if (toast || (!blocked && kind.sound !== "none")) return { delivered: true };
    return skip(blocked ? "blocked" : "suppressed-focus");
  }

  // The banner is a courtesy; the transcript already has the news.
  const result = await notify({
    title: event.title,
    body: event.body.slice(0, BODY_LIMIT),
    target,
    silent: kind.sound !== "system",
  }).catch(() => "unsupported" as const);
  // Blocked means silent too. The OS's own sound rides on the banner.
  if (result !== "blocked" && kind.sound !== "system") void playSound(kind.sound, prefs.volume);
  return result === "shown" ? { delivered: true } : skip(result);
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

/** Forgets what went out, for tests. */
export function resetNotifications(): void {
  recent.clear();
  visible = null;
}
