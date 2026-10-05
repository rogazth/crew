import { useCallback } from "react";
import type { Launch } from "../chrome/TabLauncher";
import { setFirstPrompt } from "../lib/firstPrompt";
import { fitChoice, type AgentChoice, type ProviderId } from "../lib/providers";
import type { Session, StubKind } from "../lib/types";
import { nextSessionName } from "../lib/workspaces";
import { useDefaultAgent } from "./useDefaultAgent";
import type { useSessions } from "./useSessions";

type Deps = {
  sessions: Session[];
  /** Where a new session runs: the worktree on screen. */
  worktree: string | null;
  create: ReturnType<typeof useSessions>["create"];
  openSession: (session: Session) => void;
  openStub: (stub: StubKind, title: string) => void;
  openTerminal: (worktree: string | null) => void;
  openBrowser: (url?: string, incognito?: boolean) => void;
  newBot: () => void;
};

/** New sessions and the tab launcher's picks. */
export function useLaunch({ sessions, worktree, create, openSession, openStub, openTerminal, openBrowser, newBot }: Deps) {
  const { effective: defaultAgent } = useDefaultAgent();

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(
    /**
     * `pick` is a whole choice, as Home's composer makes one, or a provider,
     * which takes the default's model when it is the default's and its effort
     * and access where they fit. `place` puts it in a worktree other than the
     * one on screen; null is the main checkout. `prompt` is its first message,
     * handed to the CLI as it starts.
     */
    async (pick: ProviderId | AgentChoice = defaultAgent, place: string | null = worktree, prompt?: string) => {
      const choice =
        typeof pick === "object"
          ? pick
          : fitChoice({ ...defaultAgent, provider: pick, model: pick === defaultAgent.provider ? defaultAgent.model : "" });
      const session = await create("terminal", {
        name: nextSessionName(sessions, choice.provider),
        provider: choice.provider,
        model: choice.model,
        effort: choice.effort,
        description: "",
        autonomy: choice.access,
        worktree: place,
      });
      if (!session) return;
      if (prompt) setFirstPrompt(session.id, prompt);
      openSession(session);
    },
    [create, defaultAgent, openSession, sessions, worktree],
  );

  const launch = useCallback(
    (item: Launch) => {
      if (item.kind === "stub") {
        if (item.stub === "terminal") openTerminal(worktree);
        else openStub(item.stub, item.title);
      }
      if (item.kind === "browser") openBrowser(item.url, item.incognito);
      if (item.kind === "new-bot") newBot();
      if (item.kind === "new-session") void newSession(item.provider);
      if (item.kind === "session") openSession(item.session);
    },
    [newBot, newSession, openSession, openStub, openTerminal, openBrowser, worktree],
  );

  return { newSession, launch };
}
