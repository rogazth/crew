import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { homeDir } from '../lib/host';
import { useCommands } from '../hooks/useCommand';
import { useSessionActivity } from '../hooks/useSessionActivity';
import { nudgeTitle } from '../hooks/useSessionTitle';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import * as api from '../lib/api';
import { homeFor, sessionCwd } from '../lib/client/registry';
import { claudeSessionId, transcriptPath } from '../lib/claudeStorage';
import { bindProviderSession } from '../lib/turnRuntime';
import { isHanded } from '../lib/handedSessions';
import { announceSession, askNews } from '../lib/notifications';
import { reconnectAfterSignIn } from '../lib/mcp';
import { clearFirstPrompt, peekFirstPrompt } from '../lib/firstPrompt';
import { BYPASS_KEY } from '../lib/permissions';
import { providerOf } from '../lib/providers';
import { reportsLive, sessionSurface } from '../lib/sessionView';
import { readLive, subscribeLive } from '../lib/sessionLive';
import { onSessionLost, useRunningSessions } from '../lib/runningSessions';
import { sessionCommand } from '../lib/sessionCommand';
import { titleName } from '../lib/terminalStatus';
import { isTerminalTab, relativeTo, sessionPtyId } from '../lib/tabs';
import { activeTerminal } from '../lib/terminalFocus';
import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS } from '../lib/terminalPrefs';
import { SessionsStrip } from './chat/ChatBar';
import { useChatActions } from './chat/context';
import { childrenOf } from '../lib/letters';
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
 * tells what it does, from its hooks and its exit. A session in the chat view
 * has no terminal at all: Crew drives its CLI, and its tab is a `TurnChat`.
 */
export function Terminals({ panes, sessions, onStatus, onOpenFile }: Props) {
  const focused = panes.find((pane) => pane.visible) ?? null;
  const running = useRunningSessions();
  const shown = new Set(panes.flatMap((pane) => (pane.tab.kind === 'session' ? [pane.tab.sessionId] : [])));
  const detached = sessions.filter((s) => sessionSurface(s) === 'terminal' && running.has(s.id) && !shown.has(s.id));
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
    isTerminalTab(focused?.tab ?? null, sessions)
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
      const { signIn } = tab;
      return (
        <Pane key={pane.id} active={visible}>
          <TerminalView
            id={pane.id}
            cwd={cwd}
            command={signIn?.command ?? []}
            active={visible}
            // A login leaves the shell behind to read what it said, and its end has the session connect the server.
            shellOnExit={signIn !== undefined}
            onExit={signIn && (() => void reconnectAfterSignIn(pane.id, signIn.sessionId, signIn.server))}
            onOpenPath={(path) => openPath(cwd, path)}
          />
        </Pane>
      );
    }
    if (tab.kind !== 'session') return null;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session || sessionSurface(session) !== 'terminal') return null;
    const here = sessionCwd(session.id) ?? cwd;
    return (
      <Pane key={pane.id} active={visible}>
        <SessionTerminal
          ptyId={sessionPtyId(session.workspaceId, session.id)}
          session={session}
          sessions={sessions}
          cwd={here}
          active={visible}
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

/** argv for the session's CLI. */
async function launchCommand(session: Session, cwd: string): Promise<string[]> {
  // Read at every launch, so a change in Settings reaches the next session started.
  const bypass = await api
    .stateGet(BYPASS_KEY)
    .then((raw) => raw?.trim() === 'on')
    .catch(() => false);
  return sessionArgv(session, cwd, bypass);
}

async function sessionArgv(session: Session, cwd: string, bypass: boolean): Promise<string[]> {
  const theme = DARK_SCHEME.matches ? 'dark' : 'light';
  const binding = providerOf(session.provider)?.binding;
  const prompt = peekFirstPrompt(session.id);
  if (binding === 'own') {
    // A `/clear` from its last run the daemon never read: resume where the CLI went.
    const moved = await api.rebindClaudeSession(session.id).catch(() => null);
    if (moved) bindProviderSession(session.id, moved);
    const current = moved ? { ...session, providerSessionId: moved } : session;
    // Claude keeps its transcripts in the home of the machine it runs on.
    const resume = await Promise.resolve(homeFor(cwd) ?? homeDir())
      .then((home) => api.pathExists(transcriptPath(home, cwd, claudeSessionId(current))))
      .catch(() => false);
    return sessionCommand(current, { resume, theme, bypass, ...(prompt ? { prompt } : {}) });
  }
  if (binding === 'before' && !session.providerSessionId) {
    const created = await api.createProviderSession(session.id).catch(() => null);
    if (created) {
      bindProviderSession(session.id, created);
      return sessionCommand({ ...session, providerSessionId: created }, { resume: true, theme, bypass, cwd, ...(prompt ? { prompt } : {}) });
    }
  }
  return sessionCommand(session, { resume: false, theme, bypass, cwd, ...(prompt ? { prompt } : {}) });
}

type SessionProps = {
  /** Its session's, not its pane's: the tab can close and open again in another strip. */
  ptyId: string;
  session: Session;
  /** Every session: its children, and whoever its letters name. */
  sessions: Session[];
  cwd: string;
  active: boolean;
  onStatus: (id: string, status: SessionStatus) => void;
  onOpenPath: (path: string) => void;
};

/** Settles which provider session to resume before the first spawn, and learns it after when the CLI names its own. */
function SessionTerminal({
  ptyId,
  session,
  sessions,
  cwd,
  active,
  onStatus,
  onOpenPath,
}: SessionProps) {
  const [command, setCommand] = useState<string[] | null>(null);
  // Latched while the tab is up, and kept after they leave: the CLI still starts
  // if create-chat (or the first frames) outlast the look.
  const [opened, setOpened] = useState(false);
  if (active && !opened) setOpened(true);
  const [startedAt, setStartedAt] = useState(0);
  /** Bumped when the CLI has to be started again: its daemon restarted without it. */
  const [launch, setLaunch] = useState(0);
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
      // Taken only by the launch that runs: a cancelled one leaves it for the next.
      clearFirstPrompt(session.id);
      setStartedAt(Date.now());
      setCommand(argv);
    });
    return () => {
      cancelled = true;
    };
    // The session row changes on rename; the process is already running by then.
    // Its provider changes only once the daemon ended the CLI it ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.provider, cwd, launch]);

  // As a window opening finds it: the CLI resumes its conversation in a new pane.
  const relaunch = useCallback(() => {
    onExit(null);
    setCommand(null);
    setLaunch((n) => n + 1);
  }, [onExit]);

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
  const { openSession } = useChatActions();
  const kids = useMemo(() => childrenOf(sessions).get(session.id) ?? [], [session.id, sessions]);

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
            shellOnExit
            detach
            onExit={onExit}
            onLost={relaunch}
            onBell={onBell}
            onActivity={onActivity}
            onTitle={retitled}
            onInput={onInput}
            onResize={onResize}
            onOpenPath={onOpenPath}
            // Not before git lists its worktree: until then it reads as the main checkout.
            // A tab already opened starts too, hidden again while the CLI is still coming up.
            eager={(isHanded(session.id) && cwd === session.worktree) || opened}
          />
        </Suspense>
      )}
      {kids.length > 0 && (
        // Over the terminal its children are still one click away.
        // The plate is opaque: a translucent one lets the glyphs through.
        <div className="absolute top-2 right-3 z-10 flex max-w-[70%] items-start gap-1.5">
          {/* Its padding would drop the chips below the button; the margin puts them back on one top. */}
          <div className="-mt-0.5 flex min-w-0 rounded-chrome bg-surface p-0.5 shadow-float">
            <SessionsStrip kids={kids} onOpen={openSession} label={false} />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * What the CLI's hooks say it does is the word on its status: a turn, a
 * question. A new ask is news under its own kind, a question or a permission,
 * said before the status that follows it is.
 */
function useLiveHooks(session: Session, onLive: (working: boolean, asking: boolean, background: boolean) => void) {
  const hooked = reportsLive(session.provider);
  const latest = useRef(session);
  useEffect(() => {
    latest.current = session;
  });
  useEffect(() => {
    if (!hooked) return;
    let last: string | null = null;
    let asked: number | null = null;
    return subscribeLive(session.id, () => {
      const live = readLive(session.id);
      if (!live) return;
      const background = live.background === true;
      const now = `${live.working}:${live.ask?.id ?? ''}:${background}`;
      if (now === last) return;
      // The first word heard may be an ask from before this window opened; only a new one is news.
      if (live.ask && last !== null && live.ask.id !== asked) announceSession(latest.current, ...askNews(live.ask));
      asked = live.ask?.id ?? null;
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
  // Its daemon restarted and the CLI went with it: as good as an exit nobody announced.
  useEffect(() => onSessionLost((id) => id === session.id && onExit(null)), [session.id, onExit]);
  return null;
}
