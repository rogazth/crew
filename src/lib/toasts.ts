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

/** What a session's news says it did, after its name. Anything else has a title that says it already. */
const VERBS: Partial<Record<NotificationSource, string>> = {
  "needs-input": "needs your answer",
  approval: "wants your approval",
  error: "hit an error",
  done: "finished",
  mailbox: "sent you a message",
  bell: "rang the bell",
};

/** Bodies that repeat what the verb just said: the row is its title alone. */
const REPEATS_THE_VERB = new Set(["Needs your input", "Ran into an error"]);

export function toastText(news: Pick<ToastNews, "title" | "body" | "source" | "target">): { title: string; description: string | null } {
  const verb = news.target ? VERBS[news.source] : undefined;
  return {
    title: verb ? `${news.title} ${verb}` : news.title,
    description: verb && REPEATS_THE_VERB.has(news.body) ? null : news.body,
  };
}
