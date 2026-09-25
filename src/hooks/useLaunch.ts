import { useCallback } from "react";
import type { Launch } from "../chrome/TabLauncher";
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
  openBrowser: (url?: string) => void;
  newAgent: () => void;
};

/** New sessions and the tab launcher's picks. */
export function useLaunch({ sessions, worktree, create, openSession, openStub, openBrowser, newAgent }: Deps) {
  const { effective: defaultAgent } = useDefaultAgent();

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(
    /** `place` puts it in a worktree other than the one on screen; null is the main checkout. */
    async (provider: ProviderId = defaultAgent.provider, place: string | null = worktree) => {
      const model = provider === defaultAgent.provider ? defaultAgent.model : DEFAULT_MODEL;
      const session = await create("terminal", {
        name: nextSessionName(sessions, provider),
        provider,
        model,
        description: "",
        autonomy: "ask",
        worktree: place,
      });
      if (session) openSession(session);
    },
    [create, defaultAgent, openSession, sessions, worktree],
  );

  const launch = useCallback(
    (item: Launch) => {
      if (item.kind === "stub") openStub(item.stub, item.title);
      if (item.kind === "browser") openBrowser(item.url);
      if (item.kind === "new-agent") newAgent();
      if (item.kind === "new-session") void newSession(item.provider);
      if (item.kind === "session") openSession(item.session);
    },
    [newAgent, newSession, openSession, openStub, openBrowser],
  );

  return { newSession, launch };
}
