import { useEffect } from "react";
import { AgentChat } from "./AgentChat";
import { setForeground } from "../lib/agentRuntime";
import type { ProviderId } from "../lib/providers";
import { isAgentTab } from "../lib/tabs";
import type { Session, Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  cwd: string;
  onModel: (session: Session, provider: ProviderId, model: string) => void;
};

/**
 * Open agent tabs stay mounted so a switch keeps scroll position and draft.
 * The turn itself lives in the runtime, so unmounting would lose nothing.
 */
export function Agents({ tabs, activeId, sessions, cwd, onModel }: Props) {
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const foreground = isAgentTab(active, sessions) && active?.kind === "session" ? active.sessionId : null;

  useEffect(() => {
    setForeground(foreground);
    return () => setForeground(null);
  }, [foreground]);

  return tabs.map((tab) => {
    if (!isAgentTab(tab, sessions) || tab.kind !== "session") return null;
    const session = sessions.find((row) => row.id === tab.sessionId);
    if (!session) return null;
    return (
      <div key={tab.id} hidden={tab.id !== activeId} className="absolute inset-0">
        <AgentChat session={session} cwd={cwd} onModel={onModel} />
      </div>
    );
  });
}
