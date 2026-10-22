import { lazy, Suspense, useCallback } from 'react';
import { useCommands } from '../hooks/useCommand';
import { useTerminalPrefs } from '../hooks/useTerminalPrefs';
import { reconnectAfterSignIn } from '../lib/mcp';
import { restartAfterSignIn } from '../lib/providerSignIn';
import { isTerminalTab, relativeTo } from '../lib/tabs';
import { activeTerminal } from '../lib/terminalFocus';
import { clamp, DEFAULT_TERMINAL_PREFS, LIMITS } from '../lib/terminalPrefs';
import type { MountedPane } from './WorkspacePanes';
import type { ProjectFile } from '../lib/types';

/** xterm and its addons are ~800 kB of the bundle; the window opens without them. */
const TerminalView = lazy(() => import('./TerminalView').then((m) => ({ default: m.TerminalView })));

type Props = {
  panes: MountedPane[];
  onOpenFile: (file: ProjectFile) => void;
  /** A tab's `input` was written to its process: the tab drops it. */
  onInputSent?: (workspaceId: string, tabId: string) => void;
};

/**
 * Every open shell tab stays mounted, shown or not, and of every workspace,
 * so a tab or workspace switch never has to repaint a terminal from the ring.
 * Unmounting a shell's terminal kills it. A session has no terminal at all:
 * Crew drives its CLI over the provider's protocol, and its tab is a `TurnChat`.
 */
export function Terminals({ panes, onOpenFile, onInputSent }: Props) {
  const focused = panes.find((pane) => pane.visible) ?? null;
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
    isTerminalTab(focused?.tab ?? null)
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

  return panes.map((pane) => {
    const { tab, cwd, visible } = pane;
    if (tab.kind !== 'stub' || tab.stub !== 'terminal') return null;
    const { signIn } = tab;
    return (
      <div key={pane.id} hidden={!visible} className="absolute inset-0">
        {/* Per pane, so the first terminal's chunk does not blank the ones already running. */}
        <Suspense fallback={null}>
          <TerminalView
            id={pane.id}
            cwd={cwd}
            command={signIn?.command ?? []}
            {...(tab.input !== undefined && { initialInput: tab.input })}
            {...(tab.input !== undefined && onInputSent && { onInputSent: () => onInputSent(pane.workspaceId, tab.id) })}
            active={visible}
            // A login leaves the shell behind to read what it said. An MCP login
            // then connects the server; the provider's own login restarts the CLI.
            shellOnExit={signIn !== undefined}
            onExit={
              signIn &&
              ((code) => {
                if (signIn.server) void reconnectAfterSignIn(pane.id, signIn.sessionId, signIn.server);
                else restartAfterSignIn(pane.id, signIn.sessionId, code);
              })
            }
            onOpenPath={(path) => openPath(cwd, path)}
          />
        </Suspense>
      </div>
    );
  });
}
