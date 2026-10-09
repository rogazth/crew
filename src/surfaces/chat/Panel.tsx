import { useEffect, useMemo, useRef, useState } from "react";
import { BotIcon, ServerIcon, SquareIcon, TerminalIcon, UsersIcon } from "lucide-react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useNow } from "../../hooks/useNow";
import { entryDetail, panelSummary, stepCursor, tokensLabel, tokensTitle, type PanelEntry, type PanelKind, type PanelState } from "../../lib/backgroundPanel";

/** A session's background work as the composer draws it, and what can be done with each entry. */
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
  if (kind === "agent") return <BotIcon className={className} />;
  if (kind === "crew") return <UsersIcon className={className} />;
  if (kind === "process") return <ServerIcon className={className} />;
  return <TerminalIcon className={className} />;
}

/** What an entry is: the CLI's mark for a Crew subagent, the kind's glyph for the rest. */
export function EntryIcon({ entry, className }: { entry: PanelEntry; className: string }) {
  if (entry.provider) return <ProviderIcon provider={entry.provider} className={className} />;
  return <PanelKindIcon kind={entry.kind} className={`${className} text-icon`} />;
}

/**
 * The status line's running work ("2 agents · 1 shell", or "3 finished"
 * once nothing runs), and the sheet it opens over the composer. A click
 * outside the sheet closes it. While it is open the arrow keys move through
 * the entries, Enter opens one, x stops it and Esc closes the sheet; the
 * composer leaves Esc to it, so it does not also stop the turn.
 */
export function WorkSegment({
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
  const shown = open && entries.length > 0;
  const sheet = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The selection follows an entry, not a row: the list reorders as work ends.
  const [picked, setPicked] = useState<string | null>(null);
  const at = Math.max(0, entries.findIndex((entry) => entry.id === picked));
  const now = useNow(1000, shown && running);

  // The sheet takes the keys, so the arrows do not move the caret of a field behind it.
  useEffect(() => {
    if (shown) sheet.current?.focus({ preventScroll: true });
  }, [shown]);

  // Everything cleared while it was open: it closes, or the next entry would open it.
  const empty = entries.length === 0;
  useEffect(() => {
    if (empty && open) onOpenChange(false);
  }, [empty, open, onOpenChange]);

  useEffect(() => {
    if (!shown) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sheet.current?.contains(target) || trigger.current?.contains(target)) return;
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
      const entry = entries[at];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setPicked(entries[stepCursor(at, event.key === "ArrowDown" ? 1 : -1, entries.length)]?.id ?? null);
      } else if (event.key === "Enter" && entry && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        onOpenChange(false);
        work.onOpen(entry);
      } else if (event.key === "x" && entry?.state === "running" && entry.stoppable) {
        work.onStop(entry);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown, entries, at, work, onOpenChange, onEscape]);

  useEffect(() => {
    if (shown) sheet.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [shown, at]);

  if (entries.length === 0) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={shown}
        onClick={() => {
          // Each time it opens, the selection starts at the top: running work.
          if (!open) setPicked(null);
          onOpenChange(!open);
        }}
        className={`flex h-6 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-text ${running ? "text-text-muted" : "text-placeholder"}`}
      >
        {running && <span className="crew-bg-dot" aria-hidden />}
        {summary.text}
      </button>
      {shown && (
        <div
          ref={sheet}
          tabIndex={-1}
          data-work-sheet
          className="absolute inset-x-6 bottom-full z-10 mb-2 flex max-h-[min(60vh,460px)] flex-col overflow-y-auto overscroll-contain rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border outline-none"
        >
          <div className="flex items-center px-2 pt-1 pb-1.5 text-[11px] text-text-muted">
            Background work
            <span className="flex-1" />
            {summary.finished > 0 && (
              <button type="button" onClick={work.onClear} className="rounded px-1.5 hover:bg-hover hover:text-text">
                Clear finished
              </button>
            )}
          </div>
          <div role="listbox" aria-label="Background work" className="flex flex-col">
            {entries.map((entry, index) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                now={now}
                selected={index === at}
                error={work.failed[entry.id]}
                onSelect={() => setPicked(entry.id)}
                onOpen={() => {
                  onOpenChange(false);
                  work.onOpen(entry);
                }}
                onStop={() => work.onStop(entry)}
              />
            ))}
          </div>
          <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">↑↓ select · ↵ open · x stop · esc close</div>
        </div>
      )}
    </>
  );
}

/** One entry: its icon with its state, what it is, how long, how many tokens, and what it is on now. */
function EntryRow({
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
  onSelect: () => void;
  onOpen: () => void;
  onStop: () => void;
}) {
  const tokens = tokensLabel(entry);
  return (
    <div
      role="option"
      aria-selected={selected}
      data-entry={entry.id}
      onMouseEnter={onSelect}
      onClick={onOpen}
      className={`group flex w-full cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-left ${selected ? "bg-hover" : ""}`}
    >
      <span className="relative grid size-8 shrink-0 place-items-center rounded-lg bg-card">
        <EntryIcon entry={entry} className="size-4" />
        <span className="absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-surface">
          <StateDot state={entry.state} />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={entry.detail || entry.title} className={`truncate text-[13px] leading-[18px] ${entry.state === "running" ? "" : "text-text-muted"}`}>
          {entry.title}
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
      <QuietStop entry={entry} onStop={onStop} />
    </div>
  );
}

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
