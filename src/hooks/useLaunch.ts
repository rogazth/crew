import { useCallback } from "react";
import type { Launch } from "../chrome/TabLauncher";
import { setFirstPrompt } from "../lib/firstPrompt";
import { DEFAULT_MODEL, type ProviderId } from "../lib/providers";
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
  newAgent: () => void;
};

/** New sessions and the tab launcher's picks. */
export function useLaunch({ sessions, worktree, create, openSession, openStub, openTerminal, openBrowser, newAgent }: Deps) {
  const { effective: defaultAgent } = useDefaultAgent();

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(
    /**
     * `place` puts it in a worktree other than the one on screen; null is the
     * main checkout. `prompt` is its first message, handed to the CLI as it starts.
     */
    async (provider: ProviderId = defaultAgent.provider, place: string | null = worktree, prompt?: string) => {
      const model = provider === defaultAgent.provider ? defaultAgent.model : DEFAULT_MODEL;
      const session = await create("terminal", {
        name: nextSessionName(sessions, provider),
        provider,
        model,
        description: "",
        autonomy: "ask",
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
      if (item.kind === "new-agent") newAgent();
      if (item.kind === "new-session") void newSession(item.provider);
      if (item.kind === "session") openSession(item.session);
    },
    [newAgent, newSession, openSession, openStub, openTerminal, openBrowser, worktree],
  );

  return { newSession, launch };
}
