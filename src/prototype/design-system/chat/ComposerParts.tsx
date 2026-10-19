// PROTOTYPE — throwaway. The redesigned composer's pieces. Composer.tsx keeps
// every bit of its logic and, while a direction is on, lays these out instead
// of the shipped markup: the activity strip over it, the context row, the
// attach menu, the joined model chip, the context ring and the send button
// that turns into Stop.
import "./chat.css";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpIcon,
  AtSignIcon,
  ChevronUpIcon,
  GitBranchIcon,
  ImageIcon,
  MessageCircleMoreIcon,
  MonitorIcon,
  PaperclipIcon,
  PlusIcon,
  SlashIcon,
  SquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { PANEL, ROW } from "../../../chrome/kit";
import { useNow } from "../../../hooks/useNow";
import { panelSummary } from "../../../lib/backgroundPanel";
import { tokenCount, useContextMeter } from "../../../lib/contextMeter";
import { providerOf } from "../../../lib/providers";
import { duration } from "../../../lib/time";
import type { PanelScope } from "../../../surfaces/chat/Panel";
import { awaitsUser, isOpen, type Block } from "../../../lib/blocks";
import { turnStart } from "../../../lib/transcriptRows";
import type { Session } from "../../../lib/types";
import { branchOf, useWhere, type Where } from "./where";

/** What the chat knows about the turn in progress, for the strip. */
export type TurnActivity = {
  /** When the turn began. */
  since?: number;
  /** What it is doing right now: the open tool's title, "Thinking", "Writing". */
  step?: string;
  /** What the card above wants, when one waits. */
  ask?: "approval" | "question";
  /** How many messages there are: none is a new session. */
  empty?: boolean;
};

/** What the strip says about the turn, read off the transcript. */
export function turnActivity(blocks: readonly Block[]): TurnActivity {
  const since = turnStart(blocks);
  const last = blocks.at(-1);
  const tool = [...blocks].reverse().find((block) => block.role === "tool" && isOpen(block));
  const step = tool?.tool?.title ?? (last?.role === "reasoning" ? "Thinking" : last?.streaming ? "Writing" : undefined);
  const card = [...blocks].reverse().find(awaitsUser);
  return {
    ...(since !== undefined ? { since } : {}),
    ...(step ? { step } : {}),
    ...(card ? { ask: card.role === "question" ? ("question" as const) : ("approval" as const) } : {}),
    empty: blocks.length === 0,
  };
}

type StripState = "working" | "waiting" | "background" | "attention";

/**
 * A slim tab tucked under the composer's top edge, there only while
 * something runs or waits on you. One language for the three: the arc in
 * front, the slow arc behind, amber when it is your move.
 */
export function ActivityStrip({
  name,
  working,
  waiting,
  activity,
  work,
  escBack,
  onStop,
  onJump,
  onShowWork,
}: {
  name: string;
  working: boolean;
  waiting: boolean;
  activity?: TurnActivity | undefined;
  work?: PanelScope | undefined;
  escBack: boolean;
  onStop: () => void;
  onJump: () => void;
  onShowWork: () => void;
}) {
  const summary = work ? panelSummary(work.entries) : null;
  const running = summary ? summary.running.agents + summary.running.sessions + summary.running.shells + summary.running.processes : 0;
  const state: StripState | null = waiting
    ? "waiting"
    : working
      ? "working"
      : summary && summary.attention > 0
        ? "attention"
        : running > 0
          ? "background"
          : null;
  const now = useNow(1000, state === "working");
  if (!state) return null;

  const since = activity?.since;
  return (
    <div data-ds-strip data-state={state} className="ds-strip" role="status" aria-live="polite">
      <span className="ds-strip-glyph">
        {state === "working" ? (
          <span className="crew-typing" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        ) : state === "background" ? (
          <span className="crew-bg-dot" aria-hidden />
        ) : state === "waiting" ? (
          <MessageCircleMoreIcon className="size-3.5" aria-hidden />
        ) : (
          <span className="ds-strip-halo" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {state === "working" && (
          <>
            <b>{name}</b> is working
            {activity?.step && <> · {activity.step}</>}
            {since !== undefined && <span className="tabular-nums"> · {duration(Math.max(0, now - since))}</span>}
          </>
        )}
        {state === "waiting" && (
          <>
            <b>{name}</b> {activity?.ask === "question" ? "asked you a question" : "needs your approval"}
          </>
        )}
        {state === "background" && (
          <>
            Turn finished · <b>{summary!.text}</b> still running
          </>
        )}
        {state === "attention" && <b>{summary!.attentionText}</b>}
      </span>
      {state === "working" &&
        (escBack ? (
          <button type="button" className="ds-strip-action" onClick={onStop}>
            Stop
          </button>
        ) : (
          <span className="shrink-0 pr-1">
            <kbd>esc</kbd>to stop
          </span>
        ))}
      {state === "waiting" && (
        <button type="button" className="ds-strip-action" onClick={onJump}>
          Show me
          <ChevronUpIcon className="size-3.5" />
        </button>
      )}
      {(state === "background" || state === "attention") && (
        <button type="button" className="ds-strip-action" onClick={onShowWork}>
          Show
          <ChevronUpIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The context row: the machine, when it is not this one. Mentions are marked in the text itself, never twice. */
export function ContextRow({
  where,
  hidePlace = false,
  children,
}: {
  where: Where;
  /** The page already says where it runs. */
  hidePlace?: boolean;
  children?: ReactNode;
}) {
  // Where it runs is the tab's and the sidebar's to say; the row only adds a remote machine.
  const remote = where.remote && !hidePlace;
  if (!remote && !children) return null;
  return (
    <div className="ds-context">
      {remote && (
        <span className="ds-tag" title={`Runs on ${where.machine}`}>
          <MonitorIcon />
          <span>{where.machine}</span>
        </span>
      )}
      {children}
    </div>
  );
}

/** The worktree a session works in, at the status line's left: its branch, when it is one worth naming. */
export function WorktreeSegment({ session }: { session: Session }) {
  const branch = branchOf(useWhere(session));
  if (!branch) return null;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 pl-2 text-text-muted" title={`Worktree: ${branch}`}>
      <GitBranchIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{branch}</span>
    </span>
  );
}

/** The context row for a session's composer: reads where it runs itself, so the shipped composer never asks. */
export function SessionContextRow({ session, hidePlace = false }: { session: Session; hidePlace?: boolean }) {
  const where = useWhere(session);
  return <ContextRow where={where} hidePlace={hidePlace} />;
}

/** The plus: attach, mention, command. Each one does what typing would. */
export function AttachMenu({
  onAttach,
  onMention,
  onCommand,
}: {
  onAttach: () => void;
  onMention: () => void;
  onCommand: () => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label="Add to the message" title="Attach, mention or run a command" className="ds-icon-btn">
        <PlusIcon className="size-[18px]" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className={`${PANEL} w-60`}>
            <Menu.Item className={ROW} onClick={onAttach}>
              <PaperclipIcon className="size-4 text-icon" />
              <span className="flex-1">Files and images…</span>
            </Menu.Item>
            <Menu.Item className={ROW} onClick={onMention}>
              <AtSignIcon className="size-4 text-icon" />
              <span className="flex-1">Mention a file</span>
              <kbd className="font-sans text-[11px] text-text-muted">@</kbd>
            </Menu.Item>
            <Menu.Item className={ROW} onClick={onCommand}>
              <SlashIcon className="size-4 text-icon" />
              <span className="flex-1">Run a command</span>
              <kbd className="font-sans text-[11px] text-text-muted">/</kbd>
            </Menu.Item>
            <Menu.Separator className="mx-2 my-1 h-px bg-hairline" />
            <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-text-muted">
              <ImageIcon className="size-4 shrink-0 opacity-70" />
              Paste a screenshot with ⌘V
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const R = 7;
const C = 2 * Math.PI * R;

/**
 * How full the context window is, as a ring by the send button; the numbers
 * on hover. PROTOTYPE: a chat with messages and no reading yet shows a mocked
 * one, so the ring can be judged on the seeded data.
 */
export function ContextRing({ sessionId, provider, mock }: { sessionId: string; provider: string; mock: boolean }) {
  const real = useContextMeter(sessionId);
  const reading = real?.window ? real : mock ? { used: 68_400, window: 200_000, autoCompactAt: 167_000, stale: false } : null;
  if (!reading?.window) return null;
  const share = Math.min(1, reading.used / reading.window);
  const percent = Math.round(share * 100);
  const label = providerOf(provider)?.label ?? provider;
  return (
    <span data-context-meter className="ds-ring" {...(share >= 0.8 ? { "data-full": "" } : {})} aria-label={`Context ${percent}% full`}>
      <svg viewBox="0 0 18 18" className={`size-[18px] -rotate-90 ${reading.stale ? "opacity-50" : ""}`} aria-hidden>
        <circle cx="9" cy="9" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${share * C} ${C}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      <span className="text-[11px] tabular-nums">{percent}%</span>
      <span className="ds-ring-card">
        <span className="flex items-baseline justify-between text-[12px] text-text-muted">
          <span>Context window</span>
          <span className="tabular-nums">{percent}%</span>
        </span>
        <span className="mt-1 block text-[15px] font-medium tabular-nums">
          {tokenCount(reading.used)} <span className="text-[12.5px] font-normal text-text-muted">of {tokenCount(reading.window)}</span>
        </span>
        <span className="mt-2.5 block h-1 w-full overflow-hidden rounded-full bg-hairline">
          <span className="block h-full rounded-full bg-text-muted" style={{ width: `${share * 100}%` }} />
        </span>
        <span className="mt-2 block text-[11.5px] leading-4 text-text-muted">
          {reading.stale
            ? "From before the last compaction. Updates on the next answer."
            : reading.autoCompactAt
              ? `Auto-compacts at ${tokenCount(reading.autoCompactAt)}.`
              : `${label} auto-compacts near the limit.`}
        </span>
      </span>
    </span>
  );
}

/** The one round button: Send, or Stop with the arc turning around it while a turn runs. */
export function SendButton({
  stopping,
  canSend,
  label,
  title,
  stopTitle,
  onStop,
}: {
  stopping: boolean;
  canSend: boolean;
  label: string;
  title: string;
  stopTitle: string;
  onStop: () => void;
}) {
  // The glyph pops when Send and Stop trade places, not when a chat first draws it.
  const [was, setWas] = useState(stopping);
  const [swapped, setSwapped] = useState(false);
  if (was !== stopping) {
    setWas(stopping);
    setSwapped(true);
  }
  const pop = swapped ? { "data-swapped": "" } : {};
  return stopping ? (
    <button key="stop" type="button" data-stop {...pop} onClick={onStop} aria-label="Stop" title={stopTitle} className="ds-send">
      <SquareIcon className="size-3 fill-current" />
    </button>
  ) : (
    <button key="send" type="submit" {...pop} disabled={!canSend} aria-label={label} title={title} className="ds-send">
      <ArrowUpIcon className="size-[18px]" strokeWidth={2.25} />
    </button>
  );
}

/** Scrolls to the card that waits in this chat and rings it once; its first choice takes the focus. */
export function jumpToCard(from: HTMLElement | null) {
  const scope = from?.closest("[data-ds-chat]") ?? document;
  const cards = scope.querySelectorAll<HTMLElement>(".crew-card");
  const card = cards[cards.length - 1];
  if (!card) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  card.removeAttribute("data-ds-flash");
  void card.offsetWidth;
  card.setAttribute("data-ds-flash", "");
  window.setTimeout(() => card.removeAttribute("data-ds-flash"), 1200);
  card.querySelector<HTMLElement>("input, button:not(:disabled), textarea")?.focus({ preventScroll: true });
}
