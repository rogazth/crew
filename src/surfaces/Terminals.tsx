import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";
import { TerminalView } from "./TerminalView";
import * as api from "../lib/api";
import { transcriptPath } from "../lib/claudeStorage";
import { sessionCommand } from "../lib/sessionCommand";
import type { Session, Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  cwd: string;
};

/**
 * Every open terminal tab stays mounted, shown or not: unmounting a terminal
 * kills its process, and a tab switch must not end a claude session.
 */
export function Terminals({ tabs, activeId, sessions, cwd }: Props) {
  return tabs.map((tab) => {
    const active = tab.id === activeId;
    if (tab.kind === "stub" && tab.stub === "terminal") {
      return (
        <Pane key={tab.id} active={active}>
          <TerminalView id={tab.id} cwd={cwd} command={[]} active={active} />
        </Pane>
      );
    }
    if (tab.kind !== "session") return null;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session || session.kind !== "terminal") return null;
    return (
      <Pane key={tab.id} active={active}>
        <SessionTerminal tabId={tab.id} session={session} cwd={cwd} active={active} />
      </Pane>
    );
  });
}

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div hidden={!active} className="absolute inset-0">
      {children}
    </div>
  );
}

const DARK_SCHEME = window.matchMedia("(prefers-color-scheme: dark)");

type SessionProps = { tabId: string; session: Session; cwd: string; active: boolean };

/** Resolves whether the provider already holds a transcript before the first spawn. */
function SessionTerminal({ tabId, session, cwd, active }: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((home) => api.pathExists(transcriptPath(home, cwd, session.id)))
      .catch(() => false)
      .then((resume) => {
        if (cancelled) return;
        const theme = DARK_SCHEME.matches ? "dark" : "light";
        setCommand(sessionCommand(session, { resume, theme }));
      });
    return () => {
      cancelled = true;
    };
    // The session row changes on rename; the process is already running by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, cwd]);

  if (!command) return null;
  return <TerminalView id={tabId} cwd={cwd} command={command} active={active} />;
}
