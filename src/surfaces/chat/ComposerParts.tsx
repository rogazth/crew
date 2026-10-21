// The composer's pieces. Composer.tsx keeps the logic and lays these out: the
// agent clip over it, the remote badge, the attach menu, the joined model
// chip, the context ring and the send button that turns into Stop.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpIcon,
  AtSignIcon,
  ChevronUpIcon,
  GitBranchIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
  SlashIcon,
  SquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { PANEL, ROW } from "../../chrome/kit";
import type { PanelEntry } from "../../lib/backgroundPanel";
import { tokenCount, useContextMeter } from "../../lib/contextMeter";
import { IS_MAC } from "../../lib/hotkey";
import { providerOf } from "../../lib/providers";
import type { PanelScope } from "./Panel";
import type { Session } from "../../lib/types";
import { branchOf, useWhere, type Where } from "./where";

/** An agent among the work: a native subagent or a session someone started. Shells, processes and bot conversations are not the clip's. */
export const isAgent = (entry: PanelEntry) => entry.kind === "subagent" || entry.kind === "session";

type ClipState = "working" | "attention" | "quiet";

const agents = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;

/** What the clip says about the agents, if there are any: who runs, who waits on the user, or that they ended. */
export function clipOf(work: PanelScope | undefined): { state: ClipState; label: ReactNode } | null {
  const all = work?.entries.filter(isAgent) ?? [];
  if (all.length === 0) return null;
  const running = all.filter((entry) => entry.state === "running");
  const waiting = running.filter((entry) => entry.attention);
  if (waiting.length > 0) {
    const [only] = waiting;
    return {
      state: "attention",
      label:
        waiting.length === 1 && only ? (
          <>
            <b>{only.title}</b> {only.attention === "approval" ? "needs approval" : "asks you"}
          </>
        ) : (
          <>
            <b>{agents(waiting.length)}</b> wait on you
          </>
        ),
    };
  }
  if (running.length > 0)
    return {
      state: "working",
      label: (
        <>
          <b>{agents(running.length)}</b> working
        </>
      ),
    };
  // One that failed did not finish: it is counted on its own, and one that was stopped likewise.
  const failed = all.filter((entry) => entry.state === "failed").length;
  const stopped = all.filter((entry) => entry.state === "stopped").length;
  const finished = all.length - failed - stopped;
  const parts = [
    ...(finished > 0 ? [`${agents(finished)} finished`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(stopped > 0 ? [`${stopped} stopped`] : []),
  ];
  return { state: "quiet", label: parts.join(" · ") };
}

/**
 * A slim tab tucked under the composer's top edge, there only while the chat
 * has agents: the ones running, the ones that wait on you, and quietly the
 * ones that ended. The turn itself is the transcript's ("Working for…"). A
 * click unfolds the tab upward, in place, into the list of those agents:
 * `children` is that list, drawn by the same element that holds the tab.
 */
export function AgentClip({
  work,
  open,
  onToggle,
  children,
}: {
  work: PanelScope | undefined;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const clip = clipOf(work);
  if (!clip) return null;
  return (
    <div data-agent-strip data-state={clip.state} className="ds-strip" {...(open ? { "data-open": "" } : {})}>
      {children}
      <button type="button" className="ds-strip-head" aria-expanded={open} onClick={onToggle}>
        <span className="ds-strip-glyph">
          {clip.state === "working" ? (
            <span className="crew-bg-dot" aria-hidden />
          ) : clip.state === "attention" ? (
            <span className="ds-strip-halo" aria-hidden />
          ) : (
            <span className="ds-strip-rest" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{clip.label}</span>
        <ChevronUpIcon className="ds-strip-chevron size-3.5 shrink-0" aria-hidden />
      </button>
    </div>
  );
}

/** The machine a session runs on, at the status line's left, when it is not this one. */
export function RemoteSegment({ where, hidePlace = false }: { where: Where; hidePlace?: boolean }) {
  // Where it runs is the tab's and the sidebar's to say; the line only adds a remote machine.
  if (!where.remote || hidePlace) return null;
  return (
    <span className="ds-tag" title={`Runs on ${where.machine}`}>
      <ServerIcon />
      <span>{where.machine}</span>
    </span>
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

/** The remote badge for a session's status line: reads where it runs itself, so the shipped composer never asks. */
export function SessionRemoteSegment({ session, hidePlace = false }: { session: Session; hidePlace?: boolean }) {
  const where = useWhere(session);
  return <RemoteSegment where={where} hidePlace={hidePlace} />;
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
              Paste a screenshot with {IS_MAC ? "⌘V" : "Ctrl+V"}
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
 * on hover. Nothing until the CLI has reported a window.
 */
export function ContextRing({ sessionId, provider }: { sessionId: string; provider: string }) {
  const reading = useContextMeter(sessionId);
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
