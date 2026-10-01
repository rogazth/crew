import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { homeDir } from '../lib/host';
import { useCommands } from '../hooks/useCommand';
import { useSessionView } from '../hooks/useSessionView';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { nudgeTitle } from '../hooks/useSessionTitle';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import * as api from '../lib/api';
import { homeFor, sessionCwd } from '../lib/client/registry';
import { claudeSessionId, transcriptPath } from '../lib/claudeStorage';
import { bindProviderSession } from '../lib/agentRuntime';
import { isHanded } from '../lib/handedSessions';
import { blockingScreen, type BlockingScreen } from '../lib/blockingScreen';
import { BYPASS_KEY } from '../lib/permissions';
import { providerOf } from '../lib/providers';
import { reportsLive, sessionSurface } from '../lib/sessionView';
import { readLive, subscribeLive } from '../lib/sessionLive';
import { useRunningSessions } from '../lib/runningSessions';
import { sessionCommand } from '../lib/sessionCommand';
import { titleName } from '../lib/terminalStatus';
import { isTerminalTab, relativeTo, sessionPtyId } from '../lib/tabs';
import { activeTerminal } from '../lib/terminalFocus';
import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS } from '../lib/terminalPrefs';
import { BackToChat, SessionChat } from './SessionChat';
import type { MountedPane } from './WorkspacePanes';
import type { ProjectFile, Session, SessionStatus } from '../lib/types';

/** xterm and its addons are ~800 kB of the bundle; the window opens without them. */
const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

type Props = {
  panes: MountedPane[];
  sessions: Session[];
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenFile: (file: ProjectFile) => void;
};

/**
 * Every open terminal tab stays mounted, shown or not, and of every workspace,
 * so a tab or workspace switch never has to repaint a terminal from the ring.
 * Unmounting a shell's terminal kills it. A session's lets go of its CLI,
 * which runs on in crewd: its tab reopens onto the same process, and only
 * Stop, or removing the session, ends it. While its tab is closed a row still
 * tells what it does, from its hooks and its exit.
 */
export function Terminals({ panes, sessions, onStatus, onOpenFile }: Props) {
  const focused = panes.find((pane) => pane.visible) ?? null;
  const running = useRunningSessions();
  const shown = new Set(panes.flatMap((pane) => (pane.tab.kind === 'session' ? [pane.tab.sessionId] : [])));
  const detached = sessions.filter((s) => s.kind === 'terminal' && running.has(s.id) && !shown.has(s.id));
  const { prefs, update } = useTerminalPrefs();
  const { view, surfaceOf, showTerminal } = useSessionView();
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
    isTerminalTab(focused?.tab ?? null, sessions, surfaceOf)
      ? {
          find: () => activeTerminal()?.find(),
          'zoom-in': () => zoom(1),
          'zoom-out': () => zoom(-1),
          'zoom-reset': () => zoom(0),
        }
      : {},
  );

  const openPath = useCallback(
    (cwd: string, path: string) =>
      onOpenFile({
        name: path.split('/').pop() ?? path,
        path,
        relative: relativeTo(cwd, path),
      }),
    [onOpenFile],
  );

  const mounted = panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (tab.kind === 'stub' && tab.stub === 'terminal') {
      return (
        <Pane key={pane.id} active={visible}>
          <TerminalView
            id={pane.id}
            cwd={cwd}
            command={[]}
            active={visible}
            onOpenPath={(path) => openPath(cwd, path)}
          />
        </Pane>
      );
    }
    if (tab.kind !== 'session') return null;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session || session.kind !== 'terminal') return null;
    const here = sessionCwd(session.id) ?? cwd;
    const surface = surfaceOf(session);
    return (
      <Pane key={pane.id} active={visible}>
        <SessionTerminal
          ptyId={sessionPtyId(session.workspaceId, session.id)}
          session={session}
          cwd={here}
          active={visible}
          chat={surface === 'chat'}
          // The setting draws this one as the chat; "Show terminal" put its terminal in front for now.
          revealed={surface === 'terminal' && sessionSurface(session, view) === 'chat'}
          onShowTerminal={(show) => showTerminal(session.id, show)}
          onStatus={onStatus}
          onOpenPath={(path) => openPath(here, path)}
        />
      </Pane>
    );
  });
  return [
    ...mounted,
    ...detached.map((session) => <DetachedSession key={`detached:${session.id}`} session={session} onStatus={onStatus} />),
  ];
}

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div hidden={!active} className="absolute inset-0">
      {/* Per pane, so the first terminal's chunk does not blank the ones already running. */}
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}

const DARK_SCHEME = window.matchMedia('(prefers-color-scheme: dark)');
/** codex and opencode write their session only once the first message is sent. */
const DISCOVER_MS = 3000;

async function launchCommand(session: Session, cwd: string): Promise<string[]> {
  const theme = DARK_SCHEME.matches ? 'dark' : 'light';
  // Read at every launch, so a change in Settings reaches the next session started.
  const bypass = await api
    .stateGet(BYPASS_KEY)
    .then((raw) => raw?.trim() === 'on')
    .catch(() => false);
  const binding = providerOf(session.provider)?.binding;
  if (binding === 'own') {
    // A `/clear` from its last run the daemon never read: resume where the CLI went.
    const moved = await api.rebindClaudeSession(session.id).catch(() => null);
    if (moved) bindProviderSession(session.id, moved);
    const current = moved ? { ...session, providerSessionId: moved } : session;
    // Claude keeps its transcripts in the home of the machine it runs on.
    const resume = await Promise.resolve(homeFor(cwd) ?? homeDir())
      .then((home) => api.pathExists(transcriptPath(home, cwd, claudeSessionId(current))))
      .catch(() => false);
    return sessionCommand(current, { resume, theme, bypass });
  }
  if (binding === 'before' && !session.providerSessionId) {
    const created = await api.createProviderSession(session.id).catch(() => null);
    if (created) {
      bindProviderSession(session.id, created);
      return sessionCommand({ ...session, providerSessionId: created }, { resume: true, theme, bypass, cwd });
    }
  }
  return sessionCommand(session, { resume: false, theme, bypass, cwd });
}

type SessionProps = {
  /** Its session's, not its pane's: the tab can close and open again in another strip. */
  ptyId: string;
  session: Session;
  cwd: string;
  active: boolean;
  /** Crew's chat is drawn over the terminal. */
  chat: boolean;
  /** The terminal is in front of a chat the setting asks for. */
  revealed: boolean;
  onShowTerminal: (show: boolean) => void;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenPath: (path: string) => void;
};

/** Settles which provider session to resume before the first spawn, and learns it after when the CLI names its own. */
function SessionTerminal({
  ptyId,
  session,
  cwd,
  active,
  chat,
  revealed,
  onShowTerminal,
  onStatus,
  onOpenPath,
}: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);
  const [blocked, setBlocked] = useState<BlockingScreen | null>(null);
  const provider = session.provider;
  const readScreen = useCallback(
    (lines: string[]) => {
      const next = blockingScreen(provider, lines);
      setBlocked((prev) => (prev?.kind === next?.kind ? prev : next));
    },
    [provider],
  );
  const [startedAt, setStartedAt] = useState(0);
  const { onBell, onActivity, onTitle, onInput, onResize, onExit, onLive } = useSessionActivity(session, active, onStatus);
  const named = useRef('');
  const retitled = useCallback(
    (title: string) => {
      onTitle(title);
      const name = titleName(title);
      if (name === named.current) return;
      named.current = name;
      nudgeTitle(session.id);
    },
    [onTitle, session.id],
  );

  useEffect(() => {
    let cancelled = false;
    launchCommand(session, cwd).then((argv) => {
      if (cancelled) return;
      setStartedAt(Date.now());
      setCommand(argv);
    });
    return () => {
      cancelled = true;
    };
    // The session row changes on rename; the process is already running by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, cwd]);

  // Claude's moves to a new conversation reach the window from the daemon,
  // which follows its SessionStart hook; the others name theirs once, later.
  const binding = providerOf(session.provider)?.binding;
  const learns = binding === 'after' && !session.providerSessionId;
  useEffect(() => {
    if (!learns || !startedAt) return;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      api
        .discoverProviderSession(session.id, cwd, startedAt)
        .then((found) => found && bindProviderSession(session.id, found))
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, DISCOVER_MS);
    return () => window.clearInterval(timer);
  }, [learns, startedAt, session.id, cwd]);

  useLiveHooks(session, onLive);

  return (
    <>
      {command && (
        <Suspense fallback={null}>
          <TerminalView
            id={ptyId}
            cwd={cwd}
            command={command}
            session={session.id}
            active={active}
            covered={chat}
            shellOnExit
            detach
            onExit={onExit}
            onBell={onBell}
            onActivity={onActivity}
            onTitle={retitled}
            onInput={onInput}
            onResize={onResize}
            onOpenPath={onOpenPath}
            onScreen={chat ? readScreen : undefined}
            // Not before git lists its worktree: until then it reads as the main checkout.
            eager={isHanded(session.id) && cwd === session.worktree}
          />
        </Suspense>
      )}
      {chat && (
        <SessionChat
          session={session}
          ptyId={ptyId}
          cwd={cwd}
          active={active}
          blocked={blocked}
          busy={session.status === 'working' || session.status === 'needs-input'}
          onShowTerminal={() => onShowTerminal(true)}
        />
      )}
      {revealed && <BackToChat onClick={() => onShowTerminal(false)} />}
    </>
  );
}

/** What the CLI's hooks say it does is the word on its status: a turn, a question. */
function useLiveHooks(session: Session, onLive: (working: boolean, asking: boolean, background: boolean) => void) {
  const hooked = reportsLive(session.provider);
  useEffect(() => {
    if (!hooked) return;
    let last: string | null = null;
    return subscribeLive(session.id, () => {
      const live = readLive(session.id);
      if (!live) return;
      const background = live.background === true;
      const now = `${live.working}:${live.ask?.id ?? ''}:${background}`;
      if (now === last) return;
      last = now;
      onLive(live.working, live.ask !== undefined, background);
    });
  }, [hooked, session.id, onLive]);
}

/**
 * A session whose tab closed while its CLI ran on: nothing to draw, but its row
 * still says when a turn ends unseen or stops to ask, and when the CLI exits.
 * A CLI without hooks keeps the status it had when its tab closed.
 */
function DetachedSession({ session, onStatus }: { session: Session; onStatus: (id: string, status: SessionStatus) => void }) {
  const { onExit, onLive } = useSessionActivity(session, false, onStatus, true);
  useLiveHooks(session, onLive);
  const ptyId = sessionPtyId(session.workspaceId, session.id);
  useEffect(() => api.onPtyExit(ptyId, onExit), [ptyId, onExit]);
  return null;
}
