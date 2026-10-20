import { memo, useEffect, useState } from 'react';
import { TurnChat } from './TurnChat';
import { ChatContext, useChatActions } from './chat/context';
import { setForeground } from '../lib/turnRuntime';
import { isTurnTab } from '../lib/tabs';
import type { MountedPane } from './WorkspacePanes';
import type { Session } from '../lib/types';

type Props = {
  panes: MountedPane[];
  sessions: Session[];
};

/**
 * Open tabs of chats Crew runs turn by turn (a bot's, a child's, a session's)
 * stay mounted, across workspaces too, so a switch keeps the draft and the scroll position.
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
        <ChatPane session={session} sessions={sessions} cwd={cwd} active={visible} />
      </div>
    );
  });
}

type PaneProps = { session: Session; sessions: Session[]; cwd: string; active: boolean };

/**
 * A chat out of sight draws again only for its own row: the list of every
 * session and the shell's actions are taken as they were when it was last on
 * screen. With a hundred tabs open, a session made anywhere, or a command's
 * run changing state, would otherwise redraw all of them.
 */
const ChatPane = memo(
  function ChatPane({ session, sessions, cwd, active }: PaneProps) {
    const actions = useChatActions();
    const [kept, setKept] = useState(actions);
    if (active && kept !== actions) setKept(actions);
    return (
      <ChatContext value={active ? actions : kept}>
        <HeldChat session={session} sessions={sessions} cwd={cwd} active={active} />
      </ChatContext>
    );
  },
  (prev, next) => !prev.active && !next.active && prev.session === next.session && prev.cwd === next.cwd,
);

const HeldChat = memo(
  TurnChat,
  (prev, next) => !prev.active && !next.active && prev.session === next.session && prev.cwd === next.cwd,
);
