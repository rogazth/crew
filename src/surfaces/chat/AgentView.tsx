import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { SquareIcon, XIcon } from 'lucide-react';
import { IconButton } from '../../chrome/kit';
import { useNow } from '../../hooks/useNow';
import { KIND_LABEL, modelLine, tokensLabel, tokensTitle, type PanelEntry } from '../../lib/backgroundPanel';
import type { Block } from '../../lib/blocks';
import type { BackgroundCommand } from '../../lib/protocol';
import { agentDetail, subagentView, threadBlocks } from '../../lib/subagent';
import { duration } from '../../lib/time';
import { ShellOutput } from './Background';
import { EntryIcon, StateDot } from './Panel';
import { Transcript } from './Transcript';

const HEAD_FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]';

/** One level of the way down to the open thread: a session that holds the level below it. */
export type Crumb = {
  id: string;
  name: string;
  provider: string;
  /** A bot wears its face, a session its CLI's mark. */
  bot: boolean;
  /** Goes back to this level: closes every thread above it. */
  back: () => void;
};

type Props = {
  entry: PanelEntry;
  /** The sessions above this thread, outermost first; the last one holds it. */
  crumbs: readonly Crumb[];
  /** Who started it, for the header's second line: the child's own row. */
  startedBy?: string;
  /** The worktree it runs in, when it has one of its own. */
  worktree?: string | null;
  /** A native subagent's calls in the transcript, oldest first: its steps live in them. A call that continued it adds one. */
  blocks: readonly Block[];
  /** The board command behind a shell. */
  command?: BackgroundCommand;
  /** The session that holds the command, and whether its CLI is up, to read a shell's output. */
  sessionId: string;
  live: boolean;
  /** A session's own chat (an agent with a transcript), with or without its composer. */
  chat?: ReactNode;
  error: string | undefined;
  /** False while the tab sits behind another one: Esc and x are the shown one's. */
  active: boolean;
  onStop: () => void;
  onClose: () => void;
};

/**
 * The threads open on screen, innermost last: only the last one answers Esc
 * and x, so a thread opened from inside another is the one that goes back.
 */
const open: symbol[] = [];

/** Why there is nothing to write to, and the keys the thread answers to. */
function ReadOnlyFooter({ entry, parent, stoppable }: { entry: PanelEntry; parent: string; stoppable: boolean }) {
  const why =
    entry.kind === 'shell'
      ? 'Output of a shell'
      : entry.origin === 'crew'
        ? 'Exited · start another with delegate'
        : `Read only · its report goes to ${parent}`;
  return (
    <div
      className="mx-auto flex h-11 w-full max-w-[840px] shrink-0 items-center gap-2 px-6 text-[11.5px] text-placeholder"
      data-thread-footer
    >
      <span className="truncate">{why}</span>
      <span className="flex-1" />
      <span className="shrink-0">
        <kbd className="font-sans">esc</kbd> back
        {stoppable && (
          <>
            {' '}
            · <kbd className="font-sans">x</kbd> stop
          </>
        )}
      </span>
    </div>
  );
}

const noop = () => {};

/** A native subagent's thread, drawn by the chat's own transcript: its prompts, its steps and its answers, in order. */
function SubagentTranscript({ calls, working, active }: { calls: readonly Block[]; working: boolean; active: boolean }) {
  const blocks = useMemo(() => threadBlocks(calls), [calls]);
  return (
    <Transcript
      blocks={blocks}
      working={working}
      active={active}
      more={false}
      loadingEarlier={false}
      onLoadEarlier={noop}
      focusId={null}
      onApprove={noop}
      onAnswer={noop}
      since={calls.at(-1)?.at}
    />
  );
}

/**
 * One agent's thread as the whole pane: a floating name pill with a close button, the body by kind
 * (a session's chat, a native subagent's steps, a shell's output), and either
 * the agent's own composer or a footer that says why there is none. The chat
 * that opened it stays mounted underneath. Esc goes back one level and never
 * stops the agent; x stops what can be stopped from here.
 */
export function AgentView({
  entry,
  crumbs,
  startedBy,
  worktree,
  blocks,
  command,
  sessionId,
  live,
  chat,
  error,
  active,
  onStop,
  onClose,
}: Props) {
  const running = entry.state === 'running';
  const now = useNow(1000, running);
  const root = useRef<HTMLDivElement>(null);
  // An agent with a composer stops from it, as any session does.
  const stoppable = running && entry.stoppable && !entry.writable;
  // The newest call is the one at work; the first names the thread.
  const first = blocks[0];
  const last = blocks.at(-1);
  const detail = first ? agentDetail(first) : null;
  const view = last ? subagentView(last) : null;
  const parent = crumbs.at(-1);

  const token = useRef(Symbol('thread'));
  useEffect(() => {
    const mine = token.current;
    open.push(mine);
    return () => void open.splice(open.indexOf(mine), 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      // Only the innermost thread answers.
      if (open.at(-1) !== token.current) return;
      // Esc that something in the page already used (a picker, a card) is not a way out; the work sheet takes it first.
      if (event.key === 'Escape' && !event.defaultPrevented && !root.current?.querySelector('[data-work-sheet]')) onClose();
      const target = event.target as HTMLElement;
      if (
        event.key === 'x' &&
        stoppable &&
        !target.closest('textarea, input, [contenteditable]') &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      )
        onStop();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, stoppable, onClose, onStop]);

  const tokens = tokensLabel(entry);
  const model = modelLine(entry);
  // Still running, but what waits on the user says so: the same words as the status line.
  const state =
    entry.attention === 'approval'
      ? 'Needs approval'
      : entry.attention === 'question'
        ? 'Asks'
        : entry.state[0]!.toUpperCase() + entry.state.slice(1);
  const branch = worktree ? worktree.split('/').pop() : null;
  const meta: ReactNode[] = [KIND_LABEL[entry.kind]];
  if (entry.kind === 'shell') meta.push(command?.command ?? entry.title);
  else {
    if (entry.kind === 'session') meta.push('yours');
    else if (entry.model) meta.push(entry.effort ? `${entry.model} · ${entry.effort}` : entry.model);
    if (entry.kind === 'subagent' && parent) meta.push(`reports to ${parent.name}`);
    else if (entry.kind === 'session' && (startedBy ?? parent?.name)) meta.push(`started by ${startedBy ?? parent!.name}`);
  }
  const body = chat ? (
    <div className="relative flex min-h-0 flex-1 flex-col">{chat}</div>
  ) : command && entry.kind === 'shell' ? (
    <ShellOutput key={command.id} sessionId={sessionId} command={command} live={live} />
  ) : detail && view ? (
    <SubagentTranscript calls={blocks} working={view.state === 'running'} active={active} />
  ) : (
    <div className="mx-auto w-full max-w-[840px] px-6 pt-8">
      <p className="py-0.5 text-[12.5px] text-text-muted">Steps are in the parent transcript.</p>
    </div>
  );
  const footer = !entry.writable && <ReadOnlyFooter entry={entry} parent={parent?.name ?? 'the session'} stoppable={stoppable} />;

  // The pill names this thread only: a Crew session by its name, a native subagent by its type, never the prompt it was sent.
  const name = entry.kind === 'subagent' && entry.origin === 'native' ? detail?.agentType || 'Subagent' : entry.title;
  const elapsed = duration((entry.endedAt ?? now) - entry.startedAt);

  return (
    <div ref={root} className="crew-thread absolute inset-0 z-20 flex flex-col bg-canvas" data-agent-view={entry.id}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-canvas via-canvas/90 to-transparent" />
      <header className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center gap-2 px-6" data-thread-header>
        <div
          title={[...meta, branch, tokens && tokensTitle(entry)].filter(Boolean).join(' · ')}
          className={`pointer-events-auto flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full bg-surface pl-3 shadow-float ${stoppable ? 'pr-1' : 'pr-3'}`}
        >
          <EntryIcon entry={entry} className="size-4 shrink-0" />
          <span className="min-w-0 truncate text-[13px] leading-5 font-medium">{name}</span>
          {model && <span className="shrink-0 text-[12px] text-text-muted">{model}</span>}
          <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted tabular-nums">
            {entry.attention ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" /> : <StateDot state={entry.state} />}
            <span className="text-text">{state}</span>
            {elapsed}
          </span>
          {stoppable && (
            <button
              type="button"
              title="Stop (x)"
              onClick={onStop}
              className="group/stop ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-text outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              <SquareIcon className="size-2.5 fill-current text-icon group-hover/stop:text-danger" />
              Stop
            </button>
          )}
        </div>
        <IconButton
          icon={XIcon}
          label="Close"
          title={`Back to ${parent?.name ?? 'the session'}`}
          onClick={onClose}
          className="pointer-events-auto size-9 rounded-full! bg-surface shadow-float"
        />
      </header>
      <div className="relative z-0 flex min-h-0 flex-1 flex-col pt-14">
        {error && <p className="mx-auto w-full max-w-[840px] shrink-0 px-6 pb-2 text-[12px] text-danger">{error}</p>}
        <div className={`relative flex min-h-0 flex-1 flex-col ${HEAD_FADE}`}>{body}</div>
      </div>
      {footer}
    </div>
  );
}
