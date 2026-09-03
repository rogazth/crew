import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useState } from "react";
import { TerminalView } from "./TerminalView";
import { useCommands } from "../hooks/useCommand";
import { useSessionActivity } from "../hooks/useSessionActivity";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import * as api from "../lib/api";
import { transcriptPath } from "../lib/claudeStorage";
import { sessionCommand } from "../lib/sessionCommand";
import { isTerminalTab, relativeTo } from "../lib/tabs";
import { activeTerminal } from "../lib/terminalFocus";
import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS } from "../lib/terminalPrefs";
import type { ProjectFile, Session, SessionStatus, Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  cwd: string;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenFile: (file: ProjectFile) => void;
};

/**
 * Every open terminal tab stays mounted, shown or not: unmounting a terminal
 * kills its process, and a tab switch must not end a claude session.
 */
export function Terminals({ tabs, activeId, sessions, cwd, onStatus, onOpenFile }: Props) {
  const focused = tabs.find((tab) => tab.id === activeId) ?? null;
  const { prefs, update } = useTerminalPrefs();
  const zoom = (delta: number) =>
    update({
      ...prefs,
      fontSize:
        delta === 0
          ? DEFAULT_TERMINAL_PREFS.fontSize
          : clamp(prefs.fontSize + delta, LIMITS.fontSize),
    });

  // Bound to the terminal filling the active tab, so ⌘F reaches the pane you see.
  useCommands(
    isTerminalTab(focused, sessions)
      ? {
          "find-in-terminal": () => activeTerminal()?.find(),
          "zoom-in": () => zoom(1),
          "zoom-out": () => zoom(-1),
          "zoom-reset": () => zoom(0),
        }
      : {},
  );

  const openPath = useCallback(
    (path: string) =>
      onOpenFile({
        name: path.split("/").pop() ?? path,
        path,
        relative: relativeTo(cwd, path),
      }),
    [cwd, onOpenFile],
  );

  return tabs.map((tab) => {
    const active = tab.id === activeId;
    if (tab.kind === "stub" && tab.stub === "terminal") {
      return (
        <Pane key={tab.id} active={active}>
          <TerminalView id={tab.id} cwd={cwd} command={[]} active={active} onOpenPath={openPath} />
        </Pane>
      );
    }
    if (tab.kind !== "session") return null;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session || session.kind !== "terminal") return null;
    return (
      <Pane key={tab.id} active={active}>
        <SessionTerminal
          tabId={tab.id}
          session={session}
          cwd={cwd}
          active={active}
          onStatus={onStatus}
          onOpenPath={openPath}
        />
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

type SessionProps = {
  tabId: string;
  session: Session;
  cwd: string;
  active: boolean;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenPath: (path: string) => void;
};

/** Resolves whether the provider already holds a transcript before the first spawn. */
function SessionTerminal({ tabId, session, cwd, active, onStatus, onOpenPath }: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);
  const { onBell, onActivity, onExit } = useSessionActivity(session, active, onStatus);

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
  return (
    <TerminalView
      id={tabId}
      cwd={cwd}
      command={command}
      active={active}
      onExit={onExit}
      onBell={onBell}
      onActivity={onActivity}
      onOpenPath={onOpenPath}
    />
  );
}
