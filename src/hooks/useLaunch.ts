import { useCallback } from "react";
import type { Launch } from "../chrome/TabLauncher";
import { DEFAULT_MODEL, type ProviderId } from "../lib/providers";
import type { Session, StubKind } from "../lib/types";
import { nextSessionName } from "../lib/workspaces";
import { useDefaultAgent } from "./useDefaultAgent";
import type { useSessions } from "./useSessions";

type Deps = {
  sessions: Session[];
  create: ReturnType<typeof useSessions>["create"];
  openSession: (session: Session) => void;
  openStub: (stub: StubKind, title: string) => void;
  newAgent: () => void;
};

/** New sessions and the tab launcher's picks. */
export function useLaunch({ sessions, create, openSession, openStub, newAgent }: Deps) {
  const { effective: defaultAgent } = useDefaultAgent();

  // Sessions open straight away; the name is derived, never prompted.
  const newSession = useCallback(
    async (provider: ProviderId = defaultAgent.provider) => {
      const model = provider === defaultAgent.provider ? defaultAgent.model : DEFAULT_MODEL;
      const session = await create("terminal", {
        name: nextSessionName(sessions, provider),
        provider,
        model,
        description: "",
        autonomy: "ask",
      });
      if (session) openSession(session);
    },
    [create, defaultAgent, openSession, sessions],
  );

  const launch = useCallback(
    (item: Launch) => {
      if (item.kind === "stub") openStub(item.stub, item.title);
      if (item.kind === "new-agent") newAgent();
      if (item.kind === "new-session") void newSession(item.provider);
      if (item.kind === "session") openSession(item.session);
    },
    [newAgent, newSession, openSession, openStub],
  );

  return { newSession, launch };
}
