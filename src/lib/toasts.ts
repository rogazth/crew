import { Toast } from "@base-ui/react/toast";
import type { NotificationSource } from "./notifications";
import type { NotificationTarget } from "./notify";

export type ToastData = { source: NotificationSource; target: NotificationTarget | null };

/** The window's own notifications, for news that arrives while Crew is in front. */
export const toastManager = Toast.createToastManager<ToastData>();

/** Long enough to read and reach for Open; a question waits longer, since nothing moves until it is answered. */
const TIMEOUT_MS = 6000;
const ASKING_TIMEOUT_MS = 12000;

export function showToast(toast: { title: string; body: string } & ToastData): void {
  const asking = toast.source === "needs-input" || toast.source === "error";
  toastManager.add({
    // One per session: news of it replaces the last instead of piling up.
    ...(toast.target ? { id: `session:${toast.target.sessionId}` } : {}),
    title: toast.title,
    description: toast.body,
    timeout: asking ? ASKING_TIMEOUT_MS : TIMEOUT_MS,
    priority: asking ? "high" : "low",
    data: { source: toast.source, target: toast.target },
  });
}
