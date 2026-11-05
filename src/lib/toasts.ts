import type { NotificationSource } from "./notifications";
import type { NotificationTarget } from "./notify";

export type ToastNews = { title: string; body: string; source: NotificationSource; target: NotificationTarget | null };

/** What draws the window's own notifications, for news that arrives while Crew is in front. */
export type ToastSink = { show: (news: ToastNews) => void; closeSession: (sessionId: string) => void };

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

/** Its session has been seen, so its news comes down. */
export function closeSessionToast(sessionId: string): void {
  sink?.closeSession(sessionId);
}
