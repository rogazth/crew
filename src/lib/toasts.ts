import type { NotificationSource } from "./notifications";
import type { NotificationTarget } from "./notify";

export type ToastNews = {
  title: string;
  body: string;
  source: NotificationSource;
  target: NotificationTarget | null;
  /**
   * What it is news of: a later toast with the same key replaces it, and
   * {@link closeToast} takes it down once that thing is seen or settles.
   * Defaults to the target's session.
   */
  key?: string | undefined;
  /** How long it stays, in ms. Defaults to its source's {@link TOAST_MS}. */
  duration?: number;
};

/**
 * How long a toast stays when nothing takes it down first; hovering the stack
 * holds the clock. What asks something of the user, or went wrong, stays a
 * little longer than a confirmation; the sidebar keeps the mark either way.
 */
export const TOAST_MS: Record<NotificationSource, number> = {
  "needs-input": 8000,
  approval: 8000,
  error: 8000,
  process: 8000,
  done: 5000,
  bell: 5000,
  connection: 5000,
  test: 5000,
};

/** What draws the window's own notifications, for news that arrives while Crew is in front. */
export type ToastSink = { show: (news: ToastNews) => void; close: (match: (key: string) => boolean) => void };

let sink: ToastSink | null = null;

/** The Toaster, while it is on screen; the answer takes it off. */
export function attachToasts(next: ToastSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

export function showToast(news: ToastNews): void {
  sink?.show(news);
}

/** What `key` is news of has been seen, or settled, so its toast comes down. */
export function closeToast(key: string): void {
  sink?.close((candidate) => candidate === key);
}

/** Its session has been seen, so its news comes down. */
export function closeSessionToast(sessionId: string): void {
  closeToast(sessionId);
}
