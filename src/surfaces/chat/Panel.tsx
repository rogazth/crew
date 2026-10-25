import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, MessagesSquareIcon, PauseIcon, LayersIcon, SquareIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useNow } from "../../hooks/useNow";
import { entryDetail, panelSummary, stepCursor, tokensLabel, tokensTitle, type ConversationEntry, type PanelEntry, type PanelKind, type PanelState } from "../../lib/backgroundPanel";
import type { ThreadRef } from "../../lib/letters";
import { clock } from "../../lib/time";
import type { Session } from "../../lib/types";
import { Face } from "./Letters";

/** A session's background work as the composer draws it, and what can be done with each entry. */
export type PanelScope = {
  entries: readonly PanelEntry[];
  /** What went wrong stopping an entry, by entry id. */
  failed: Readonly<Record<string, string>>;
  onOpen: (entry: PanelEntry) => void;
  onStop: (entry: PanelEntry) => void;
  onClear: () => void;
  /** Bot pairs this chat has letters with: the sheet's second group, and the segment's count. */
  conversations: readonly ConversationEntry[];
  /** Whom a conversation's faces are drawn from. */
  sessions: readonly Session[];
  onOpenConversation: (thread: ThreadRef) => void;
};

/**
 * Letters stopped waking this session after 20 turns in a row they started.
 * Writing here resumes it, as before; the status line only says so.
 */
export function PausedSegment() {
  return (
    <span
      title="Messages still arrive but won't start a turn. Write to resume."
      className="flex h-6 items-center gap-1 px-1.5 text-warning"
    >
      <PauseIcon className="size-3" aria-hidden />
      Paused after 20 automatic turns
    </span>
  );
}

/** Running pulses; a clean end is green, a failure red, a stop quiet. */
export function StateDot({ state }: { state: PanelState }) {
  if (state === "running") return <span className="crew-bg-dot" aria-hidden />;
  const tone = state === "failed" ? "bg-danger" : state === "stopped" ? "bg-placeholder" : "bg-success";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

export function PanelKindIcon({ kind, className }: { kind: PanelKind; className: string }) {
  if (kind === "subagent") return <BotIcon className={className} />;
  if (kind === "session") return <MessagesSquareIcon className={className} />;
  if (kind === "process") return <LayersIcon className={className} />;
  return <TerminalIcon className={className} />;
}

/** What an entry is: the CLI's mark for every agent, the kind's glyph for the rest. */
export function EntryIcon({ entry, className }: { entry: PanelEntry; className: string }) {
  if (entry.provider) return <ProviderIcon provider={entry.provider} className={className} />;
  return <PanelKindIcon kind={entry.kind} className={`${className} text-icon`} />;
}

/**
 * The status line's work segment: what waits on the user ("scout asks"),
 * the running work ("2 agents · 1 shell", or what ran once nothing runs)
 * and the bot conversations ("2 conversations"), and the "Work" sheet they
 * open over the composer: the entries, then the conversations. A click
 * outside the sheet closes it. While it is open the arrow keys move through
 * the entries, Enter opens one, x stops it and Esc closes the sheet; the
 * composer leaves Esc to it, so it does not also stop the turn.
 */
export const WorkSegment = memo(function WorkSegment({
  work,
  open,
  onOpenChange,
  onEscape,
  segment = false,
}: {
  work: PanelScope;
  /** Without the agents clip to open it, the sheet has its own entry: a button in the status line that floats the sheet over the composer. */
  segment?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet was closed with Esc: the composer takes the focus back. */
  onEscape: () => void;
}) {
  const { conversations } = work;
  // The agent clip opens the sheet, so the agents lead: the clip is about them, the rest of the work follows.
  const entries = useMemo(
    () => [...work.entries].sort((a, b) => Number(isAgentEntry(b)) - Number(isAgentEntry(a))),
    [work.entries],
  );
  const summary = useMemo(() => panelSummary(entries), [entries]);
  const running = entries.length > summary.finished;
  // One list for the keys: the entries, then the conversations.
  const rows = useMemo<Row[]>(
    () => [
      ...entries.map((entry): Row => ({ id: entry.id, entry })),
      ...conversations.map((conversation): Row => ({ id: `conversation:${conversation.key}`, conversation })),
    ],
    [entries, conversations],
  );
  const total = rows.length;
  const shown = open && total > 0;
  const sheet = useRef<HTMLDivElement>(null);
  // The selection follows an entry, not a row: the list reorders as work ends.
  const [picked, setPicked] = useState<string | null>(null);
  const at = Math.max(0, rows.findIndex((row) => row.id === picked));
  const now = useNow(1000, shown && running);
  const { onOpen, onOpenConversation } = work;
  const openEntry = useCallback(
    (entry: PanelEntry) => {
      onOpenChange(false);
      onOpen(entry);
    },
    [onOpen, onOpenChange],
  );
  const openConversation = useCallback(
    (thread: ThreadRef) => {
      onOpenChange(false);
      onOpenConversation(thread);
    },
    [onOpenConversation, onOpenChange],
  );

  // The sheet takes the keys, so the arrows do not move the caret of a field behind it.
  useEffect(() => {
    if (shown) sheet.current?.focus({ preventScroll: true });
  }, [shown]);

  // Everything cleared while it was open: it closes, or the next entry would open it.
  const empty = total === 0;
  useEffect(() => {
    if (empty && open) onOpenChange(false);
  }, [empty, open, onOpenChange]);

  useEffect(() => {
    if (!shown) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sheet.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-agent-strip], [data-work-trigger]")) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [shown, onOpenChange]);

  useEffect(() => {
    if (!shown) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        onEscape();
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, [contenteditable]") || event.metaKey || event.ctrlKey || event.altKey) return;
      const row = rows[at];
      const entry = row?.entry;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setPicked(rows[stepCursor(at, event.key === "ArrowDown" ? 1 : -1, rows.length)]?.id ?? null);
      } else if (event.key === "Enter" && row && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        onOpenChange(false);
        if (row.entry) work.onOpen(row.entry);
        else work.onOpenConversation(row.conversation!.thread);
      } else if (event.key === "x" && entry?.state === "running" && entry.stoppable) {
        event.preventDefault();
        work.onStop(entry);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown, rows, at, work, onOpenChange, onEscape]);

  useEffect(() => {
    // Only the sheet scrolls: scrollIntoView also scrolls every ancestor, and while the panel is mid-transition the row sits
    // below where it will rest, so it shoved the transcript and the layout around (the CLS on quick clicks).
    const box = sheet.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!shown || !box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [shown, at]);

  if (total === 0) return null;
  return (
    <>
      {segment && (
        <button
          type="button"
          data-work-trigger
          aria-expanded={shown}
          onClick={() => {
            // Each time it opens, the selection starts at the top: running work.
            if (!open) setPicked(null);
            onOpenChange(!open);
          }}
          className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          {summary.attention > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <TriangleAlertIcon className="size-3" aria-hidden />
              {summary.attentionText}
            </span>
          )}
          {summary.attention > 0 && summary.text && <span className="text-placeholder">·</span>}
          {running && <span className="crew-bg-dot" aria-hidden />}
          {summary.text}
          {(summary.text || summary.attention > 0) && conversations.length > 0 && <span className="text-placeholder">·</span>}
          {conversations.length > 0 && (
            <span className="flex items-center gap-1 text-text-muted">
              <MessagesSquareIcon className="size-3" aria-hidden />
              {conversations.length} {conversations.length > 1 ? "conversations" : "conversation"}
            </span>
          )}
        </button>
      )}
      {/* Under the clip the sheet stays mounted, closed: it unfolds and folds back instead of appearing and vanishing. */}
      {(shown || !segment) && (
      <div
        ref={sheet}
        tabIndex={-1}
        data-work-sheet
        {...(shown ? { "data-open": "", "data-keys": "x" } : {})}
        inert={!shown}
        className={
          segment
            ? "absolute inset-x-6 bottom-full z-10 mb-2 flex max-h-[min(60vh,460px)] flex-col overflow-y-auto overscroll-contain rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border outline-none"
            : "ds-strip-panel flex flex-col outline-none"
        }
      >
        <div className="flex items-center px-2 pt-1 pb-1.5 text-[11px] text-text-muted">
          Work
          <span className="flex-1" />
          {summary.finished > 0 && (
            <button type="button" onClick={work.onClear} className="rounded px-1.5 hover:bg-hover hover:text-text">
              Clear finished
            </button>
          )}
        </div>
        <div role="listbox" aria-label="Work" className="flex flex-col">
          {rows.map((row, index) =>
            row.entry ? (
              <EntryRow
                key={row.id}
                entry={row.entry}
                // Only a running row reads the clock: the ended ones skip its ticks.
                now={row.entry.state === "running" ? now : 0}
                selected={index === at}
                error={work.failed[row.id]}
                onSelect={setPicked}
                onOpen={openEntry}
                onStop={work.onStop}
              />
            ) : (
              <Fragment key={row.id}>
                {index === entries.length && (
                  <div className={`px-2 pb-1 text-[11px] text-text-muted ${entries.length > 0 ? "pt-2.5" : "pt-1"}`}>Conversations</div>
                )}
                <ConversationRow
                  id={row.id}
                  conversation={row.conversation!}
                  sessions={work.sessions}
                  selected={index === at}
                  onSelect={setPicked}
                  onOpen={openConversation}
                />
              </Fragment>
            ),
          )}
        </div>
        <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">↑↓ select · ↵ open · x stop · esc close</div>
      </div>
      )}
    </>
  );
});

const isAgentEntry = (entry: PanelEntry) => entry.kind === "subagent" || entry.kind === "session";

/** A row of the sheet's keys: an entry of the work, or a conversation. */
type Row = { id: string; entry?: PanelEntry; conversation?: ConversationEntry };

/** One conversation: the bot's face, its name, the last letter's first line and when it came. */
const ConversationRow = memo(function ConversationRow({
  id,
  conversation,
  sessions,
  selected,
  onSelect,
  onOpen,
}: {
  id: string;
  conversation: ConversationEntry;
  sessions: readonly Session[];
  selected: boolean;
  onSelect: (id: string) => void;
  onOpen: (thread: ThreadRef) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      data-conversation={conversation.key}
      onMouseEnter={() => onSelect(id)}
      onClick={() => onOpen(conversation.thread)}
      className={`flex w-full cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-left ${selected ? "bg-hover" : ""}`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card">
        <Face party={conversation.party} sessions={sessions} className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-[18px]">{conversation.label}</span>
        <span className="truncate text-[11.5px] leading-4 text-text-muted">{conversation.last}</span>
      </span>
      <span className="w-12 shrink-0 text-right text-[11px] text-placeholder tabular-nums">{clock(conversation.at)}</span>
    </div>
  );
});

/** One entry: its icon with its state, what it is, how long, how many tokens, and what it is on now. */
const EntryRow = memo(function EntryRow({
  entry,
  now,
  selected,
  error,
  onSelect,
  onOpen,
  onStop,
}: {
  entry: PanelEntry;
  now: number;
  selected: boolean;
  error: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (entry: PanelEntry) => void;
  onStop: (entry: PanelEntry) => void;
}) {
  const tokens = tokensLabel(entry);
  return (
    <div
      role="option"
      aria-selected={selected}
      data-entry={entry.id}
      data-attention={entry.attention}
      onMouseEnter={() => onSelect(entry.id)}
      onClick={() => onOpen(entry)}
      className={`group flex w-full cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-left ${selected ? "bg-hover" : ""}`}
    >
      <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-card">
        <EntryIcon entry={entry} className="size-4" />
        <span className="absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-surface">
          <StateDot state={entry.state} />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={entry.detail || entry.title} className="truncate text-[13px] leading-[18px]">
          {entry.title}
          {entry.preview && <span className="ml-2 font-mono text-[11.5px] text-text-muted">{entry.preview}</span>}
        </span>
        <span className="truncate text-[11.5px] leading-4 text-text-muted">
          {entryDetail(entry, now)}
          {tokens && (
            <span title={tokensTitle(entry)}>
              {" · "}
              {tokens}
            </span>
          )}
          {entry.state === "running" && entry.activity ? <span className="text-placeholder"> · {entry.activity}</span> : null}
          {error ? (
            <span title={error} className="text-danger">
              {" · "}
              {error}
            </span>
          ) : null}
        </span>
      </span>
      <QuietStop entry={entry} onStop={() => onStop(entry)} />
    </div>
  );
});

/**
 * Stop without a background of its own: the row's hover is the only fill, and
 * the word turns red under the pointer. Hidden until the row is hovered.
 * Work that cannot be stopped alone says why in place of it.
 */
function QuietStop({ entry, onStop }: { entry: PanelEntry; onStop: () => void }) {
  if (entry.state !== "running") return <span className="w-12 shrink-0" />;
  if (!entry.stoppable)
    return (
      <span title={entry.stopNote ?? "It can't be stopped on its own"} className="w-12 shrink-0 text-right text-[11px] text-placeholder">
        —
      </span>
    );
  return (
    <button
      type="button"
      title="Stop (x)"
      onClick={(event) => {
        event.stopPropagation();
        onStop();
      }}
      className="flex w-12 shrink-0 items-center justify-end gap-1 text-[11.5px] text-text-muted opacity-0 transition-[color,opacity] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger"
    >
      <SquareIcon className="size-2.5 fill-current" />
      Stop
    </button>
  );
}
