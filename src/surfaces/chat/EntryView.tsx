import { useEffect, useRef, type ReactNode } from "react";
import { SquareIcon } from "lucide-react";
import { Button } from "../../chrome/kit";
import { useNow } from "../../hooks/useNow";
import { KIND_LABEL, tokensLabel, tokensTitle, type PanelEntry } from "../../lib/backgroundPanel";
import type { Block } from "../../lib/blocks";
import { agentDetail, subagentView } from "../../lib/subagent";
import { duration } from "../../lib/time";
import { SubagentBody } from "./Activity";
import { EntryIcon, StateDot } from "./Panel";

const FADE = "[mask-image:linear-gradient(to_bottom,transparent,black_28px,black_calc(100%-56px),transparent)]";

type Props = {
  entry: PanelEntry;
  /** A subagent's call in the transcript: its steps live in it. Absent when the transcript does not hold it. */
  block: Block | null;
  /** A Crew subagent's chat, with its own composer. */
  chat?: ReactNode;
  error: string | undefined;
  /** False while the tab sits behind another one: Esc and x are the shown one's. */
  active: boolean;
  onStop: () => void;
  onClose: () => void;
};

/**
 * One subagent's work as a page over the chat: a Claude subagent's steps as
 * the transcript draws them, a Crew subagent's own chat with its composer.
 * Esc or Close goes back to where the reader was; x stops what can be stopped.
 */
export function EntryView({ entry, block, chat, error, active, onStop, onClose }: Props) {
  const running = entry.state === "running";
  const now = useNow(1000, running);
  const scroller = useRef<HTMLDivElement>(null);
  // A Crew subagent's Stop is in its composer, as the session's is.
  const stoppable = running && entry.stoppable && !entry.writable;
  const detail = block ? agentDetail(block) : null;
  const view = block ? subagentView(block) : null;

  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      // Esc that a field in the page already used (the composer stops its turn with it) is not a way out.
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
      const target = event.target as HTMLElement;
      if (event.key === "x" && stoppable && !target.closest("textarea, input, [contenteditable]") && !event.metaKey && !event.ctrlKey && !event.altKey) onStop();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, stoppable, onClose, onStop]);

  // A running subagent is read at its end, where the newest step lands.
  const steps = detail?.steps?.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [steps, running]);

  const tokens = tokensLabel(entry);
  const meta = [KIND_LABEL[entry.kind], entry.model, entry.detail].filter(Boolean).join(" · ");
  const state = entry.state[0]!.toUpperCase() + entry.state.slice(1);
  return (
    <div className="crew-thread absolute inset-0 z-20 flex flex-col bg-canvas" data-entry-view={entry.id}>
      <header className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-3 px-6 pt-5 pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-card">
          <EntryIcon entry={entry} className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] leading-5 font-medium">{entry.title}</span>
          <span className="truncate text-[12px] leading-4 text-text-muted">{meta}</span>
        </div>
        {/* Facts as plain text, the way Linear writes an issue's properties: no pills. */}
        <span className="flex shrink-0 items-center gap-3 text-[12px] text-text-muted tabular-nums">
          {tokens && (
            <span title={tokensTitle(entry)} className="flex items-center gap-1.5">
              {tokens}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <StateDot state={entry.state} />
            <span className="text-text">{state}</span>
            {duration((entry.endedAt ?? now) - entry.startedAt)}
          </span>
        </span>
        <span className="h-4 w-px shrink-0 bg-hairline" />
        {stoppable && (
          <Button variant="ghost" keys="x" onClick={onStop} className="group/stop h-7 px-2 text-[12.5px] font-normal hover:text-danger">
            <SquareIcon className="size-2.5 fill-current text-icon group-hover/stop:text-danger" />
            Stop
          </Button>
        )}
        <Button variant="ghost" keys="esc" onClick={onClose} className="h-7 px-2 text-[12.5px] font-normal">
          Back to the chat
        </Button>
      </header>
      {error && <p className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2 text-[12px] text-danger">{error}</p>}
      {chat ? (
        <div className="relative min-h-0 flex-1">{chat}</div>
      ) : (
        <div ref={scroller} className={`min-h-0 flex-1 overflow-y-auto ${FADE}`}>
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-1 px-6 pt-6 pb-20">
            {detail && view ? (
              <SubagentBody detail={detail} state={view.state} marked={null} />
            ) : (
              <p className="py-0.5 text-[12.5px] text-text-muted">Its steps are in the transcript, where it started.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
