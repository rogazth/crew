import { bindProviderSession } from "./agentRuntime";
import * as api from "./api";
import { claudeSessionId, transcriptPath } from "./claudeStorage";
import { homeDir } from "./host";
import { providerOf } from "./providers";
import { sessionCommand, type ClaudeTheme } from "./sessionCommand";
import type { Session } from "./types";

/** codex and opencode write their session only once the first message is sent; Claude moves to a new one on `/clear`. */
export const DISCOVER_MS = 3000;

/** argv for a session's terminal, once it is settled which provider session to resume. */
export async function launchCommand(session: Session, cwd: string, theme: ClaudeTheme): Promise<string[]> {
  const binding = providerOf(session.provider)?.binding;
  if (binding === "own") {
    const resume = await homeDir()
      .then((home) => api.pathExists(transcriptPath(home, cwd, claudeSessionId(session))))
      .catch(() => false);
    return sessionCommand(session, { resume, theme });
  }
  if (binding === "before" && !session.providerSessionId) {
    const created = await api.createProviderSession(session.id).catch(() => null);
    if (created) {
      bindProviderSession(session.id, created);
      return sessionCommand({ ...session, providerSessionId: created }, { resume: true, theme });
    }
  }
  return sessionCommand(session, { resume: false, theme });
}

export type LearnMode = "rebind" | "discover";

/**
 * How a running terminal learns its provider session: Claude is asked whether
 * `/clear` moved it, codex and opencode are looked for until they name one.
 */
export function learnMode(session: Pick<Session, "provider" | "providerSessionId">): LearnMode | null {
  const binding = providerOf(session.provider)?.binding;
  if (binding === "own") return "rebind";
  if (binding === "after" && !session.providerSessionId) return "discover";
  return null;
}

/** Polls for the provider session and binds each one found; one look at a time. Returns the stop. */
export function watchProviderSession(
  mode: LearnMode,
  sessionId: string,
  cwd: string,
  since: number,
  interval = DISCOVER_MS,
): () => void {
  const learn = () =>
    mode === "rebind"
      ? api.rebindClaudeSession(sessionId)
      : api.discoverProviderSession(sessionId, cwd, since);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    learn()
      .then((found) => found && bindProviderSession(sessionId, found))
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, interval);
  return () => clearInterval(timer);
}
