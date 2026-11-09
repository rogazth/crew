// The composer's pieces. Composer.tsx keeps the logic and lays these out: the
// agent clip over it, the line under it and its sheets, the attach menu, the
// joined model chip, the context ring and the send button that turns into Stop.
import { Menu } from "@base-ui/react/menu";
import {
  ArrowUpIcon,
  AtSignIcon,
  BotIcon,
  GaugeIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  PaperclipIcon,
  PauseIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
  SlashIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { pickerKeyDown } from "../../chrome/promptKeys";
import { PANEL, ROW } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { sessionResume } from "../../lib/api";
import type { PanelEntry } from "../../lib/backgroundPanel";
import { tokenCount, useContextMeter } from "../../lib/contextMeter";
import { providerOf } from "../../lib/providers";
import type { Session } from "../../lib/types";
import { span, useReadings, warningFor } from "../../lib/usage";
import { RAISED } from "../settings/ui";
import { useChatActions } from "./context";
import { branchOf, useWhere, type Where } from "./where";

/** Something an agent needs of the user: it waits on an answer, or it failed and nobody has looked. */
export type AgentNoticeItem = { key: string; entry: PanelEntry; asks: "question" | "approval" | "failed" };

/** The chat's agents, as the clip over the prompt draws them. */
export type AgentsLine = {
  notices: readonly AgentNoticeItem[];
  /** Everyone this chat has started. */
  agents: readonly PanelEntry[];
  conversations: number;
  working: number;
  /** There is someone to list: the clip stays when nothing wants the user. */
  any: boolean;
  /** The right panel is showing the list. */
  open: boolean;
  onOpenNotice: () => void;
  onDismiss: () => void;
  onToggleList: () => void;
};

type Tone = "warning" | "danger";
const SOFT: Record<Tone, string> = { warning: "bg-warning/16 text-warning", danger: "bg-danger/14 text-danger" };

/** A tone in a soft disc. */
function Disc({ tone, icon: Glyph, size = 18 }: { tone: Tone; icon: LucideIcon; size?: number }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-full ${SOFT[tone]}`} style={{ width: size, height: size }}>
      <Glyph strokeWidth={2.5} style={{ width: size * 0.62, height: size * 0.62 }} aria-hidden />
    </span>
  );
}

/** The one word that does something about a row. */
export function ActionWord({ children, onClick, disabled = false, plain = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; /** No underline on hover. */ plain?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] font-medium whitespace-nowrap text-info disabled:opacity-50 ${plain ? "" : "hover:underline"}`}
    >
      {children}
    </button>
  );
}

const ASK_ICON = { failed: TriangleAlertIcon, question: MessageCircleQuestionIcon, approval: ShieldCheckIcon };
const ASK_ACTION = { failed: "Open", question: "Answer", approval: "Review" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * On the prompt's top edge, only agents: what wants the user, else who works.
 * It opens the agent that asks, or the right panel with everyone; the x waves
 * what asks away until the next time.
 */
export function AgentsClip({ line }: { line: AgentsLine }) {
  const { notices, agents, working, conversations, open } = line;
  const [only] = notices;
  if (!only && !line.any) return null;
  const several = notices.length > 1;
  const quiet = working > 0 ? `${working} working` : agents.length > 0 ? plural(agents.length, "agent") : plural(conversations, "conversation");
  return (
    <div data-agent-clip {...(only ? { "data-notice": "" } : {})} className={`ds-clip ${open ? "ds-clip-on" : ""}`}>
      <div className="flex h-[30px] items-center gap-2 pr-1 pl-2 whitespace-nowrap">
        <button
          type="button"
          aria-expanded={open}
          {...(only ? { "data-agent-notice": "" } : { "data-agents-segment": "" })}
          onClick={only ? line.onOpenNotice : line.onToggleList}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors hover:text-text"
        >
          {only ? (
            <Disc tone={notices.some((one) => one.asks === "failed") ? "danger" : "warning"} icon={several ? BotIcon : ASK_ICON[only.asks]} />
          ) : (
            <span className="flex shrink-0 -space-x-1">
              {agents.length === 0 && <BotIcon className="size-3.5" aria-hidden />}
              {agents.slice(0, 3).map((one) => (
                <span key={one.id} className="grid size-[18px] place-items-center rounded-full bg-surface ring-2 ring-fill">
                  {one.provider ? <ProviderIcon provider={one.provider} className="size-3" /> : <BotIcon className="size-3" aria-hidden />}
                </span>
              ))}
            </span>
          )}
          <span className={`min-w-0 truncate ${only ? "font-medium text-text" : ""}`}>{only ? (several ? `${notices.length} agents` : only.entry.title) : quiet}</span>
        </button>
        {only && <ActionWord onClick={line.onOpenNotice}>{several ? "Review" : ASK_ACTION[only.asks]}</ActionWord>}
        {only && (
          <button type="button" data-notice-dismiss aria-label="Dismiss" title="Dismiss" onClick={line.onDismiss} className="grid size-6 shrink-0 place-items-center rounded-md text-text-muted hover:text-text">
            <XIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** A segment of the line under the prompt. Its label leaves first when the pane narrows. */
export function StatusSegment({
  ref,
  icon: Glyph,
  label,
  short,
  dot,
  open,
  ...button
}: {
  ref?: Ref<HTMLButtonElement>;
  icon: LucideIcon;
  label: string;
  short?: string;
  dot?: "running" | "warning" | "danger" | undefined;
  open: boolean;
} & Omit<ComponentProps<"button">, "ref">) {
  return (
    <button ref={ref} type="button" aria-label={label} aria-expanded={open} {...button} className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-text ${open ? "bg-hover text-text" : ""}`}>
      <span className="relative">
        <Glyph className="size-3.5" aria-hidden />
        {dot === "running" && <span data-status-dot={dot} className="crew-bg-dot absolute -top-0.5 -right-0.5 ring-1 ring-canvas" aria-hidden />}
        {(dot === "warning" || dot === "danger") && <span data-status-dot={dot} className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-canvas ${dot === "danger" ? "bg-danger" : "bg-warning"}`} aria-hidden />}
      </span>
      <span className="hidden @md:inline">{label}</span>
      {short && <span className="tabular-nums @md:hidden">{short}</span>}
    </button>
  );
}

/**
 * A sheet over the composer, as wide as the clip. It takes the keyboard when it
 * opens, so the next Tab lands in it. A click outside closes it; Esc also hands
 * the keyboard back: to the segment that opened it from the keyboard, else to
 * the prompt.
 */
export function useStatusSheet(shown: boolean, onClose: () => void, onEscape: () => void) {
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const byKey = useRef(false);
  useEffect(() => {
    if (shown) box.current?.focus({ preventScroll: true });
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || trigger.current?.contains(target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      if (byKey.current) trigger.current?.focus();
      else onEscape();
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [shown, onClose, onEscape]);
  /** A click with no pointer behind it came from the keyboard. */
  const opened = (event: { detail: number }) => {
    byKey.current = event.detail === 0;
  };
  return { box, trigger, opened };
}

export function StatusSheet({ ref, title, action, children, ...rest }: { ref: Ref<HTMLDivElement>; title?: string; action?: ReactNode; children: ReactNode } & Omit<ComponentProps<"div">, "ref" | "title">) {
  return (
    <div ref={ref} tabIndex={-1} {...rest} className="absolute inset-x-[42px] bottom-full z-20 mb-2 flex max-h-[min(50vh,320px)] flex-col overflow-y-auto overscroll-contain rounded-[14px] bg-surface p-1.5 shadow-float ring-1 ring-border outline-none">
      {title && (
        <div className="flex h-7 shrink-0 items-center pl-2 text-[12px] font-medium text-text-muted">
          {title}
          <span className="flex-1" />
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/** The plan limit the session's provider is close to, if any. */
export function useQuota(provider: string) {
  const readings = useReadings();
  const hit = warningFor(readings, provider);
  if (!hit) return null;
  const { window } = hit;
  return { name: `${window.label} limit`, used: window.used, resets: window.resetsIn !== null ? span(window.resetsIn) : null, danger: window.used >= 95 };
}

/** At the line's right when a plan limit is close, so a long turn does not start into a wall. */
export function QuotaSegment({ provider }: { provider: string }) {
  const quota = useQuota(provider);
  const { openUsage } = useChatActions();
  if (!quota) return null;
  return (
    <button type="button" data-quota title={quota.resets ? `Resets in ${quota.resets}` : undefined} onClick={openUsage} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-hover hover:text-text">
      <GaugeIcon className={`size-3.5 ${quota.danger ? "text-danger" : "text-warning"}`} aria-hidden />
      <span className="hidden @lg:inline">{quota.name}</span>
      <span className="tabular-nums">{quota.used}%</span>
    </button>
  );
}

/**
 * Closes the transcript while letters stopped waking the session after 20
 * turns in a row they started. Resume, or writing, starts the count over.
 */
export function PausedRow({ sessionId }: { sessionId: string }) {
  return (
    <div data-paused-row role="status" title="Messages still arrive but won't start a turn." className={`flex h-10 min-w-0 items-center gap-2.5 rounded-xl pr-1.5 pl-2.5 text-[12.5px] whitespace-nowrap ${RAISED}`}>
      <Disc tone="warning" icon={PauseIcon} size={20} />
      <span className="min-w-0 truncate font-medium text-text">Paused after 20 turns</span>
      <span className="flex-1" />
      <ActionWord onClick={() => void sessionResume(sessionId).catch(() => {})}>Resume</ActionWord>
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
    <span data-context-meter tabIndex={0} className="ds-ring" {...(share >= 0.8 ? { "data-full": "" } : {})} aria-label={`Context ${percent}% full`}>
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
