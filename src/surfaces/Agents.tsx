import { AgentChat } from "./AgentChat";
import { isAgentTab } from "../lib/tabs";
import type { Session, SessionStatus, Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  cwd: string;
  onStatus: (id: string, status: SessionStatus) => void;
  onBindProvider: (id: string, providerSessionId: string) => void;
};

/**
 * Every open agent tab stays mounted. Unmounting would drop the in-memory
 * turn listener; a tab switch must not end the Claude process.
 */
export function Agents({ tabs, activeId, sessions, cwd, onStatus, onBindProvider }: Props) {
  return tabs.map((tab) => {
    if (!isAgentTab(tab, sessions) || tab.kind !== "session") return null;
    const session = sessions.find((row) => row.id === tab.sessionId);
    if (!session) return null;
    return (
      <div key={tab.id} hidden={tab.id !== activeId} className="absolute inset-0">
        <AgentChat
          session={session}
          cwd={cwd}
          onStatus={onStatus}
          onBindProvider={onBindProvider}
        />
      </div>
    );
  });
}
