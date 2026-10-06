import { useEffect } from 'react';
import { TurnChat } from './TurnChat';
import { setForeground } from '../lib/turnRuntime';
import { isTurnTab } from '../lib/tabs';
import type { MountedPane } from './WorkspacePanes';
import type { Session } from '../lib/types';

type Props = {
  panes: MountedPane[];
  sessions: Session[];
};

/**
 * Open tabs of chats Crew runs turn by turn (a bot's, a child's) stay mounted,
 * across workspaces too, so a switch keeps the draft and the scroll position.
 * The turn itself lives in the runtime, which is why closing one costs nothing.
 */
export function TurnChats({ panes, sessions }: Props) {
  const shown = panes.find((pane) => pane.visible) ?? null;
  const foreground =
    shown && isTurnTab(shown.tab, sessions) && shown.tab.kind === 'session'
      ? shown.tab.sessionId
      : null;

  useEffect(() => {
    setForeground(foreground);
    return () => setForeground(null);
  }, [foreground]);

  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (!isTurnTab(tab, sessions) || tab.kind !== 'session') return null;
    const session = sessions.find((row) => row.id === tab.sessionId);
    if (!session) return null;
    return (
      <div key={pane.id} hidden={!visible} className="absolute inset-0">
        <TurnChat session={session} sessions={sessions} cwd={cwd} active={visible} />
      </div>
    );
  });
}
