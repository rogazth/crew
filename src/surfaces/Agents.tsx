import { useEffect } from 'react';
import { AgentChat } from './AgentChat';
import { setForeground } from '../lib/agentRuntime';
import { isAgentTab } from '../lib/tabs';
import type { MountedPane } from './WorkspacePanes';
import type { Session } from '../lib/types';

type Props = {
  panes: MountedPane[];
  sessions: Session[];
};

/**
 * Open agent tabs stay mounted, across workspaces too, so a switch keeps the
 * draft and the scroll position. The turn itself lives in the runtime, which is
 * why closing an agent tab costs nothing.
 */
export function Agents({ panes, sessions }: Props) {
  const shown = panes.find((pane) => pane.visible) ?? null;
  const foreground =
    shown && isAgentTab(shown.tab, sessions) && shown.tab.kind === 'session'
      ? shown.tab.sessionId
      : null;

  useEffect(() => {
    setForeground(foreground);
    return () => setForeground(null);
  }, [foreground]);

  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (!isAgentTab(tab, sessions) || tab.kind !== 'session') return null;
    const session = sessions.find((row) => row.id === tab.sessionId);
    if (!session) return null;
    return (
      <div key={pane.id} hidden={!visible} className="absolute inset-0">
        <AgentChat session={session} cwd={cwd} active={visible} />
      </div>
    );
  });
}
