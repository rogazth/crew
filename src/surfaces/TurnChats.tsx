import { memo, useEffect, useState } from 'react';
import { TurnChat } from './TurnChat';
import { ChatContext, useChatActions, type ChatActions } from './chat/context';
import { setForeground } from '../lib/turnRuntime';
import { load } from '../lib/transcript';
import { isTurnTab } from '../lib/tabs';
import type { MountedPane } from './WorkspacePanes';
import type { Session } from '../lib/types';

type Props = {
  panes: MountedPane[];
  sessions: Session[];
};

const NONE: ReadonlySet<string> = new Set();

/**
 * Open tabs of chats Crew runs turn by turn (a bot's, a child's, a session's)
 * stay mounted once they have been on screen, across workspaces too, so a
 * switch keeps the draft and the scroll position. A tab restored with its
 * strip is drawn the first time it shows; until then only its transcript is
 * read, so it opens with it. The turn itself lives in the runtime, which is
 * why closing one costs nothing.
 */
export function TurnChats({ panes, sessions }: Props) {
  const actions = useChatActions();
  const shown = panes.find((pane) => pane.visible) ?? null;
  const foreground =
    shown && isTurnTab(shown.tab, sessions) && shown.tab.kind === 'session'
      ? shown.tab.sessionId
      : null;

  useEffect(() => {
    setForeground(foreground);
    return () => setForeground(null);
  }, [foreground]);

  // Adjusted while rendering: the pane coming on screen is drawn in this same pass, and stays drawn.
  const [drawn, setDrawn] = useState(NONE);
  if (shown && !drawn.has(shown.id)) setDrawn(new Set(drawn).add(shown.id));

  // What a tab not drawn yet will show, read ahead: the runtime keeps it current from then on.
  const waiting = panes
    .flatMap((pane) => (pane.tab.kind === 'session' && !drawn.has(pane.id) && !pane.visible ? [pane.tab.sessionId] : []))
    .join(' ');
  useEffect(() => {
    for (const id of waiting.split(' ')) if (id) void load(id);
  }, [waiting]);

  const byId = new Map(sessions.map((row) => [row.id, row]));
  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (tab.kind !== 'session' || !(visible || drawn.has(pane.id))) return null;
    const session = byId.get(tab.sessionId);
    if (!session) return null;
    return (
      <div key={pane.id} hidden={!visible} className="absolute inset-0">
        <ChatPane session={session} sessions={sessions} cwd={cwd} active={visible} actions={visible ? actions : null} />
      </div>
    );
  });
}

type PaneProps = { session: Session; sessions: Session[]; cwd: string; active: boolean; actions: ChatActions | null };

/**
 * A chat out of sight draws again only for its own row: the list of every
 * session and the shell's actions are taken as they were when it was last on
 * screen. With a hundred tabs open, a session made anywhere, or a command's
 * run changing state, would otherwise redraw all of them. The actions come as
 * a prop, only to the chat on screen, so a change to them skips the rest.
 */
const ChatPane = memo(
  function ChatPane({ session, sessions, cwd, active, actions }: PaneProps) {
    const [kept, setKept] = useState(actions);
    if (actions && kept !== actions) setKept(actions);
    const value = actions ?? kept;
    const chat = <HeldChat session={session} sessions={sessions} cwd={cwd} active={active} />;
    return value ? <ChatContext value={value}>{chat}</ChatContext> : chat;
  },
  (prev, next) => !prev.active && !next.active && prev.session === next.session && prev.cwd === next.cwd,
);

const HeldChat = memo(
  TurnChat,
  (prev, next) => !prev.active && !next.active && prev.session === next.session && prev.cwd === next.cwd,
);
