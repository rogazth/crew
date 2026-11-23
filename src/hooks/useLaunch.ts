import { useCallback } from "react";
import type { AttachedFile } from "../lib/blocks";
import { carryUnsent, setFirstPrompt, type Unsent } from "../lib/firstPrompt";
import { choiceForNewSession, type AgentChoice, type ProviderId } from "../lib/providers";
import type { Session } from "../lib/types";
import { PLACEHOLDER_SESSION_NAME } from "../lib/workspaces";
import { useDefaultAgent } from "./useDefaultAgent";
import type { useSessions } from "./useSessions";

type Deps = {
  /** Where a new session runs: the worktree on screen. */
  worktree: string | null;
  create: ReturnType<typeof useSessions>["create"];
  /** Keeps a session nothing has been said in out of the sidebar. */
  markBlank: (id: string) => void;
  openSession: (session: Session) => void;
  /** Puts the start screen on screen with the caret in its composer, starting in the worktree at `place` when one is named. */
  showStart: (place?: string) => void;
};

/** New sessions: made and opened at once, or made for a tab that is waiting for them. */
export function useLaunch({ worktree, create, markBlank, openSession, showStart }: Deps) {
  const { effective: defaultAgent, setDraft, lastOf } = useDefaultAgent();

  // The name is derived, never prompted.
  const createSession = useCallback(
    /**
     * `pick` is a whole choice, as Home's composer makes one, or a provider,
     * which takes the default's model when it is the default's and its effort
     * and access where they fit. `place` puts it in a worktree other than the
     * one on screen; null is the main checkout. `prompt` is its first message:
     * it is the first turn of the chat, with `files` attached. `unsent` is
     * what another session's composer held, left in this one's as a draft.
     */
    async (pick: ProviderId | AgentChoice = defaultAgent, place: string | null = worktree, prompt?: string, files?: AttachedFile[], unsent?: Unsent) => {
      const choice = choiceForNewSession(pick, defaultAgent);
      const session = await create("terminal", {
        name: PLACEHOLDER_SESSION_NAME,
        provider: choice.provider,
        model: choice.model,
        effort: choice.effort,
        ...(choice.serviceTier ? { serviceTier: choice.serviceTier } : {}),
        description: "",
        autonomy: choice.access,
        worktree: place,
      });
      if (!session) return;
      if (prompt) setFirstPrompt(session.id, prompt, files);
      else markBlank(session.id);
      if (unsent) carryUnsent(session.id, unsent);
      return session;
    },
    [create, defaultAgent, markBlank, worktree],
  );

  // Sessions open straight away.
  const newSession = useCallback(
    async (...args: Parameters<typeof createSession>) => {
      const session = await createSession(...args);
      if (session) openSession(session);
      return session;
    },
    [createSession, openSession],
  );

  // A new session is the start screen: a provider picked for it becomes the composer's choice, nothing is created yet.
  // Whatever an earlier visit left in the composer's choice goes first, so it never outlives the session it was for.
  const startSession = useCallback(
    (pick?: ProviderId | AgentChoice, place?: string) => {
      if (typeof pick === "string") setDraft(pick === defaultAgent.provider ? null : lastOf(pick));
      else setDraft(pick ?? null);
      showStart(place);
    },
    [defaultAgent, lastOf, setDraft, showStart],
  );

  return { createSession, newSession, startSession };
}
