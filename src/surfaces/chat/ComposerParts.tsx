// The composer's pieces. Composer.tsx keeps the logic and lays these out: the
// agent clip over it, the remote badge, the attach menu, the joined model
// chip, the context ring and the send button that turns into Stop.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpIcon,
  AtSignIcon,
  GitBranchIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
  SlashIcon,
  SquareIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { pickerKeyDown } from "../../chrome/promptKeys";
import { PANEL, ROW } from "../../chrome/kit";
import { StatusDot } from "../../chrome/StatusDot";
import type { PanelEntry } from "../../lib/backgroundPanel";
import { tokenCount, useContextMeter } from "../../lib/contextMeter";
import { IS_MAC } from "../../lib/hotkey";
import { providerOf } from "../../lib/providers";
import type { Session } from "../../lib/types";
import { branchOf, useWhere, type Where } from "./where";

/** An agent among the work: a native subagent or a session someone started. Shells, processes and bot conversations are not the clip's. */
/** Something an agent needs of the user: it waits on an answer, or it failed and nobody has looked. */
export type AgentNoticeItem = { key: string; entry: PanelEntry; asks: "question" | "approval" | "failed" };

/**
 * On the prompt's top edge, only while an agent wants something: there is
 * nothing here while agents simply work. Opens the agent, or the list when
 * several want something; the x waves it away until the next time.
 */
export function AgentNotice({ notices, onOpen, onDismiss }: { notices: readonly AgentNoticeItem[]; onOpen: () => void; onDismiss: () => void }) {
  const [only] = notices;
  if (!only) return null;
  const words = notices.length > 1 ? (
    <>
      <b>{notices.length} agents</b> want you
    </>
  ) : (
    <>
      <b>{only.entry.title}</b> {only.asks === "approval" ? "needs approval" : only.asks === "question" ? "asks you" : "failed"}
    </>
  );
  return (
    <div data-agent-strip data-notice data-state="attention" className="ds-strip">
      <button type="button" data-agent-notice className="ds-strip-head pr-8" onClick={onOpen}>
        <span className="ds-strip-glyph">
          <span className="ds-strip-halo" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{words}</span>
      </button>
      <button type="button" data-notice-dismiss onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="absolute top-0 right-2 z-10 grid size-6 place-items-center rounded-md text-icon transition-colors hover:text-text">
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** In the line under the prompt, where it asks for nothing: the way to everyone this chat has worked with. */
export function AgentsSegment({ working, onToggle }: { working: number; onToggle: () => void }) {
  return (
    <button type="button" data-agents-segment onClick={onToggle} className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text">
      {working > 0 ? <StatusDot status="working" /> : <WorkflowIcon className="size-3.5" aria-hidden />}
      {working > 0 ? `${working} ${working === 1 ? "sub-agent" : "sub-agents"} working` : "View sub-agents"}
    </button>
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
  const [open, setOpen] = useState(false);
  return (
    <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger aria-label="Add to the message" title="Attach, mention or run a command" className="ds-icon-btn">
        <PlusIcon className="size-[18px]" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className={PANEL} onKeyDown={(event) => pickerKeyDown(event, null, () => setOpen(false))}>
            <Menu.Item className={ROW} onClick={onAttach}>
              <PaperclipIcon className="size-4 text-icon" />
              <span className="flex-1">Files and images…</span>
            </Menu.Item>
            <Menu.Item className={ROW} onClick={onMention}>
              <AtSignIcon className="size-4 text-icon" />
              <span className="flex-1">Mention</span>
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
