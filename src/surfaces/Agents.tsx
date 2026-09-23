import { useEffect } from 'react';
import { AgentChat } from './AgentChat';
import { agentSessionOf, foregroundAgent } from '../lib/agentChat';
import { setForeground } from '../lib/agentRuntime';
import type { ProviderId } from '../lib/providers';
import type { MountedPane } from './WorkspacePanes';
import type { Session } from '../lib/types';

type Props = {
  panes: MountedPane[];
  sessions: Session[];
  onModel: (session: Session, provider: ProviderId, model: string) => void;
};

/**
 * Open agent tabs stay mounted, across workspaces too, so a switch keeps the
 * draft and the scroll position. The turn itself lives in the runtime, which is
 * why closing an agent tab costs nothing.
 */
export function Agents({ panes, sessions, onModel }: Props) {
  const foreground = foregroundAgent(panes, sessions);

  useEffect(() => {
    setForeground(foreground);
    return () => setForeground(null);
  }, [foreground]);

  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    const session = agentSessionOf(tab, sessions);
    if (!session) return null;
    return (
      <div key={pane.id} hidden={!visible} className="absolute inset-0">
        <AgentChat session={session} cwd={cwd} active={visible} onModel={onModel} />
      </div>
    );
  });
}
