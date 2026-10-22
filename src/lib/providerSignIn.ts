import { sessionSignedIn } from "./api";
import { showToast } from "./toasts";

const seen = new Set<string>();

/**
 * The login process exited. The first exit is the login; the shell that
 * replaces it is not another one. A clean login restarts the session's CLI,
 * which is still holding the credentials it already failed to refresh.
 */
export function restartAfterSignIn(tabId: string, sessionId: string, code: number | null): void {
  if (seen.has(tabId)) return;
  seen.add(tabId);
  if (code !== 0) return;
  void sessionSignedIn(sessionId).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    showToast({
      title: "Could not restart the session",
      body: message,
      source: "error",
      target: null,
    });
  });
}
