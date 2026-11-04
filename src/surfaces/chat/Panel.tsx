import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { BotIcon, MessagesSquareIcon, LayersIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useNow } from "../../hooks/useNow";
import { entryAge, entryDetail, panelSummary, stepCursor, type PanelEntry, type PanelKind, type PanelState } from "../../lib/backgroundPanel";
import { ActionWord, StatusSegment, StatusSheet, useStatusSheet } from "./ComposerParts";

/** The processes a session left running as the composer draws them, and what can be done with each. */
export type PanelScope = {
  entries: readonly PanelEntry[];
  /** What went wrong stopping an entry, by entry id. */
  failed: Readonly<Record<string, string>>;
  onOpen: (entry: PanelEntry) => void;
  onStop: (entry: PanelEntry) => void;
  onClear: () => void;
};

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
 * Only the sheet scrolls: scrollIntoView also scrolls every ancestor, and while the panel is mid-transition the row sits
 * below where it will rest, so it shoved the transcript and the layout around (the CLS on quick clicks).
 */
function showSelected(box: HTMLElement) {
  const row = box.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!row) return;
  if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
}

/**
 * The status line's processes: how many a chat left running (or ran, once none
 * does), and the sheet they open over the composer. Agents are the clip's and
 * the panel's. While it is open the arrow keys move through the entries, Enter
 * opens one and x stops it.
 */
export const WorkSegment = memo(function WorkSegment({
  work,
  open,
  onOpenChange,
  onEscape,
}: {
  work: PanelScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet was closed with Esc: the composer takes the focus back. */
  onEscape: () => void;
}) {
  const { entries } = work;
  const summary = useMemo(() => panelSummary(entries), [entries]);
  const running = entries.length > summary.finished;
  const total = entries.length;
  const shown = open && total > 0;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { box: sheet, trigger, opened } = useStatusSheet(shown, close, onEscape);
  // The selection follows an entry, not a row: the list reorders as work ends.
  const [picked, setPicked] = useState<string | null>(null);
  const at = Math.max(0, entries.findIndex((entry) => entry.id === picked));
  const now = useNow(1000, shown && running);
  const { onOpen } = work;
  const openEntry = useCallback(
    (entry: PanelEntry) => {
      onOpenChange(false);
      onOpen(entry);
    },
    [onOpen, onOpenChange],
  );

  // Everything cleared while it was open: it closes, or the next entry would open it.
  const empty = total === 0;
  useEffect(() => {
    if (empty && open) onOpenChange(false);
  }, [empty, open, onOpenChange]);

  useEffect(() => {
    if (!shown) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, [contenteditable]") || event.metaKey || event.ctrlKey || event.altKey) return;
      const entry = entries[at];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setPicked(entries[stepCursor(at, event.key === "ArrowDown" ? 1 : -1, entries.length)]?.id ?? null);
      } else if (event.key === "Enter" && entry && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        onOpenChange(false);
        work.onOpen(entry);
      } else if (event.key === "x" && entry?.state === "running" && entry.stoppable) {
        event.preventDefault();
        work.onStop(entry);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown, entries, at, work, onOpenChange]);

  useEffect(() => {
    if (shown && sheet.current) showSelected(sheet.current);
  }, [shown, at, sheet]);

  if (total === 0) return null;
  const failed = entries.some((entry) => entry.state === "failed");
  return (
    <>
      <StatusSegment
        ref={trigger}
        data-work-trigger
        icon={LayersIcon}
        label={summary.text}
        short={String(running ? total - summary.finished : total)}
        dot={failed ? "danger" : running ? "running" : undefined}
        open={shown}
        onClick={(event) => {
          // Each time it opens, the selection starts at the top: running work.
          if (!open) setPicked(null);
          opened(event);
          onOpenChange(!open);
        }}
      />
      {shown && (
        <StatusSheet ref={sheet} data-work-sheet data-open="" data-keys="x" title="Processes" action={summary.finished > 0 ? <ActionWord onClick={work.onClear}>Clear</ActionWord> : null}>
          <div role="listbox" aria-label="Processes" className="flex flex-col">
            {entries.map((entry, index) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                // Only a running row reads the clock: the ended ones skip its ticks.
                now={entry.state === "running" ? now : 0}
                selected={index === at}
                error={work.failed[entry.id]}
                onSelect={setPicked}
                onOpen={openEntry}
                onStop={work.onStop}
              />
            ))}
          </div>
        </StatusSheet>
      )}
    </>
  );
});

/** One row: what it is, with its state on its corner, and how long it ran; Stop takes the time's place on a running one. */
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
  const live = entry.state === "running";
  return (
    <div
      role="option"
      aria-selected={selected}
      data-entry={entry.id}
      data-state={entry.state}
      data-attention={entry.attention}
      title={entry.detail || entryDetail(entry, now)}
      onMouseEnter={() => onSelect(entry.id)}
      onClick={() => onOpen(entry)}
      className={`group flex h-9 min-w-0 shrink-0 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] ${selected ? "bg-hover" : ""}`}
    >
      <span className="relative grid size-5 shrink-0 place-items-center">
        <EntryIcon entry={entry} className="size-3.5" />
        <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-surface">
          <StateDot state={entry.state} />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate">
        {entry.title}
        {entry.preview && <span className="ml-2 font-mono text-[11.5px] text-text-muted">{entry.preview}</span>}
      </span>
      {error && (
        <span title={error} className="max-w-[45%] truncate text-[12px] text-danger">
          {error}
        </span>
      )}
      <span className="relative flex shrink-0 items-center justify-end">
        <span className={`text-[12px] text-text-muted tabular-nums ${live ? "absolute right-0 group-focus-within:opacity-0 group-hover:opacity-0" : ""}`}>{entryAge(entry, now)}</span>
        {live && (
          <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <QuietStop entry={entry} onStop={() => onStop(entry)} />
          </span>
        )}
      </span>
    </div>
  );
});

/**
 * Stop without a background of its own: the row's hover is the only fill, and
 * the word turns red under the pointer. Hidden until the row is hovered.
 * Work that cannot be stopped alone says why in place of it.
 */
export function QuietStop({ entry, onStop }: { entry: PanelEntry; onStop: () => void }) {
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
      className="flex w-12 shrink-0 items-center justify-end gap-1 rounded text-[11.5px] text-text-muted opacity-0 transition-[color,opacity] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger"
    >
      <SquareIcon className="size-2.5 fill-current" />
      Stop
    </button>
  );
}
