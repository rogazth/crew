import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeftIcon, GitBranchIcon, SquareIcon } from 'lucide-react';
import { BotAvatar } from '../../chrome/BotAvatar';
import { Kbd } from '../../chrome/Kbd';
import { Button } from '../../chrome/kit';
import { ProviderIcon } from '../../chrome/ProviderIcon';
import { useNow } from '../../hooks/useNow';
import { KIND_LABEL, tokensLabel, tokensTitle, type PanelEntry } from '../../lib/backgroundPanel';
import type { Block } from '../../lib/blocks';
import type { BackgroundCommand } from '../../lib/protocol';
import { agentDetail, subagentView } from '../../lib/subagent';
import { duration } from '../../lib/time';
import { SubagentBody } from './Activity';
import { ShellOutput } from './Background';
import { EntryIcon, StateDot } from './Panel';

const FADE = '[mask-image:linear-gradient(to_bottom,transparent,black_28px,black_calc(100%-56px),transparent)]';

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
  /** A native subagent's call in the transcript: its steps live in it. */
  block: Block | null;
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

function CrumbMark({ crumb, className }: { crumb: Crumb; className: string }) {
  return crumb.bot ? (
    <BotAvatar seed={crumb.id} bare className={className} />
  ) : (
    <ProviderIcon provider={crumb.provider} className={className} />
  );
}

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

/**
 * One agent's thread as the whole pane: a breadcrumb header, the body by kind
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
  block,
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
  const scroller = useRef<HTMLDivElement>(null);
  // An agent with a composer stops from it, as any session does.
  const stoppable = running && entry.stoppable && !entry.writable;
  const detail = block ? agentDetail(block) : null;
  const view = block ? subagentView(block) : null;
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

  // A running native subagent is read at its end, where the newest step lands.
  const steps = detail?.steps?.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [steps, running]);

  const tokens = tokensLabel(entry);
  const state = entry.state[0]!.toUpperCase() + entry.state.slice(1);
  const branch = worktree ? worktree.split('/').pop() : null;
  const meta: ReactNode[] = [KIND_LABEL[entry.kind]];
  if (entry.kind === 'shell') meta.push(entry.title);
  else {
    if (entry.kind === 'session') meta.push('yours');
    else if (entry.model) meta.push(entry.model);
    if (entry.kind === 'subagent' && parent) meta.push(`reports to ${parent.name}`);
    else if (entry.kind === 'session' && (startedBy ?? parent?.name)) meta.push(`started by ${startedBy ?? parent!.name}`);
  }
  const ancestors = crumbs.slice();
  const last = ancestors.length - 1;

  return (
    <div ref={root} className="crew-thread absolute inset-0 z-20 flex flex-col bg-canvas" data-agent-view={entry.id}>
      <header className="mx-auto flex w-full max-w-[840px] shrink-0 flex-col gap-0.5 px-6 pt-5 pb-3" data-thread-header>
        <div className="flex items-center gap-1">
          <nav aria-label="Thread" className="flex min-w-0 flex-1 items-center gap-1">
            {ancestors.map((crumb, index) => (
              <span key={`${crumb.id}-${index}`} className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  onClick={crumb.back}
                  title={`Back to ${crumb.name}`}
                  className="h-7 gap-1.5 px-1.5 text-[13px] font-normal text-text-muted"
                >
                  {index === last && <ChevronLeftIcon className="size-3.5" />}
                  <CrumbMark crumb={crumb} className="size-4" />
                  <span className="max-w-[140px] truncate">{crumb.name}</span>
                </Button>
                <span className="text-placeholder">/</span>
              </span>
            ))}
            <span className="flex min-w-0 items-center gap-1.5 pl-1">
              <EntryIcon entry={entry} className="size-4 shrink-0" />
              <span className="truncate text-[15px] leading-5 font-medium">{entry.title}</span>
            </span>
          </nav>
          {/* Facts as plain text, the way Linear writes an issue's properties: no pills. */}
          <span className="flex shrink-0 items-center gap-3 text-[12px] text-text-muted tabular-nums">
            {tokens && <span title={tokensTitle(entry)}>{tokens}</span>}
            <span className="flex items-center gap-1.5">
              <StateDot state={entry.state} />
              <span className="text-text">{state}</span>
              {duration((entry.endedAt ?? now) - entry.startedAt)}
            </span>
          </span>
          <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
          {stoppable && (
            <Button variant="ghost" keys="x" onClick={onStop} className="group/stop h-7 px-2 text-[12.5px] font-normal hover:text-danger">
              <SquareIcon className="size-2.5 fill-current text-icon group-hover/stop:text-danger" />
              Stop
            </Button>
          )}
          <Kbd keys="esc" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-text-muted">
          <span className="truncate">{meta.join(' · ')}</span>
          {branch && (
            <span title={worktree ?? ''} className="flex min-w-0 shrink items-center gap-1 before:content-['·'] before:mr-0.5">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          )}
        </div>
      </header>
      {error && <p className="mx-auto w-full max-w-[840px] shrink-0 px-6 pb-2 text-[12px] text-danger">{error}</p>}
      {chat ? (
        <div className="relative flex min-h-0 flex-1 flex-col">{chat}</div>
      ) : command && entry.kind === 'shell' ? (
        <ShellOutput key={command.id} sessionId={sessionId} command={command} live={live} />
      ) : (
        <div ref={scroller} className={`min-h-0 flex-1 overflow-y-auto ${FADE}`}>
          <div className="mx-auto flex w-full max-w-[840px] flex-col gap-1 px-6 pt-6 pb-10">
            {detail && view ? (
              <SubagentBody detail={detail} state={view.state} marked={null} />
            ) : (
              <p className="py-0.5 text-[12.5px] text-text-muted">Its steps are in the transcript, where it started.</p>
            )}
          </div>
        </div>
      )}
      {!entry.writable && <ReadOnlyFooter entry={entry} parent={parent?.name ?? 'the session'} stoppable={stoppable} />}
    </div>
  );
}
