 
// PROTOTYPE — throwaway. What every header variant draws around: a small app
// window (tab strip + pane), the parent's chat underneath, the thread's body,
// its footer (composer or read-only), and the header's own pieces.
import { ChevronLeftIcon, FileTextIcon, GitBranchIcon, SearchIcon, SquareIcon, TerminalIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { Kbd } from "../../chrome/Kbd";
import { Button } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { StateDot } from "../../surfaces/chat/Panel";
import { metaOf, stateLabel, type Case, type Level } from "./data";

export function LevelMark({ level, className = "size-4" }: { level: Level; className?: string }) {
  return level.bot ? <BotAvatar seed={level.id} bare className={className} /> : <ProviderIcon provider={level.provider} className={className} />;
}

export function ThreadMark({ c, className = "size-4" }: { c: Case; className?: string }) {
  return <ProviderIcon provider={c.provider} className={`${className} shrink-0`} />;
}

/** A tab like TabBar's: the active one is canvas with a hairline ring, the rest a card. */
export function TabPill({ children, active = true, className = "" }: { children: ReactNode; active?: boolean; className?: string }) {
  return (
    <div
      className={`flex h-7 min-w-0 shrink items-center gap-1.5 rounded-chrome px-2.5 text-[12.5px] ring-1 ${
        active ? "bg-canvas text-text shadow-[0_1px_2px_var(--color-hairline)] ring-hairline" : "bg-card text-text-muted ring-transparent"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** The window: a tab strip (the root session's tab unless a variant brings its own) and the pane. */
export function Frame({ c, strip, children }: { c: Case; strip?: ReactNode; children: ReactNode }) {
  const root = c.crumbs[0]!;
  return (
    <div className="flex h-[470px] min-w-0 flex-col overflow-hidden rounded-xl bg-canvas text-text ring-1 ring-border">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-sidebar pr-2 pl-1.5">
        {strip ?? (
          <>
            <TabPill className="max-w-[190px] min-w-[120px]">
              <LevelMark level={root} className="size-3.5 shrink-0" />
              <span className="truncate">{root.name}</span>
            </TabPill>
            <TabPill active={false} className="max-w-[140px]">
              <ProviderIcon provider="claude" className="size-3.5 shrink-0" />
              <span className="truncate">planner</span>
            </TabPill>
          </>
        )}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** The chat that opened the thread, as it sits underneath. */
export function ParentChat({ c, className = "" }: { c: Case; className?: string }) {
  const parent = c.crumbs.at(-1)!;
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas ${className}`}>
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 pt-5">
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl bg-card px-3.5 py-2 text-[14px] leading-[21px]">Split the refunds work and tell me when it is ready.</div>
        </div>
        <p className="text-[14px] leading-[22px]">{c.parentLines[0]}</p>
        <Row icon={TerminalIcon}>{c.parentLines[1]}</Row>
        <div className="ml-[26px] flex items-center gap-2 rounded-xl px-3 py-2 text-[12.5px] ring-1 ring-hairline">
          <ThreadMark c={c} className="size-3.5" />
          <span className="truncate">{c.title}</span>
          <span className="flex-1" />
          <StateDot state={c.state} />
          <span className="text-text-muted">{stateLabel(c)}</span>
        </div>
        <p className="text-[14px] leading-[22px] text-text-muted">{parent.name} waits for its report.</p>
      </div>
    </div>
  );
}

function Row({ icon: Glyph, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2 text-[13px] leading-[18px] text-text-muted">
      <span className="crew-node">
        <Glyph className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** The thread's transcript: the handoff letter first, then its steps. */
export function ThreadBody({ c, className = "", top = "pt-5" }: { c: Case; className?: string; top?: string }) {
  const parent = c.crumbs.at(-1)!;
  return (
    <div className={`min-h-0 flex-1 overflow-hidden ${className}`}>
      <div className={`mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 pb-6 ${top}`}>
        <div className="flex gap-2.5 py-1">
          <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-card">
            <LevelMark level={parent} className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5 text-[12.5px]">
              <span className="font-medium text-text">{parent.name}</span>
              <span className="text-text-muted">started this session</span>
            </div>
            <p className="line-clamp-3 text-[14px] leading-[21px]">{c.handoff}</p>
          </div>
        </div>
        <Row icon={SearchIcon}>Grep "refund" in crates/api/tests</Row>
        <Row icon={FileTextIcon}>Read crates/api/tests/webhooks.rs</Row>
        <p className="text-[14px] leading-[22px]">
          {c.state === "running" ? "Two fixtures load a full-amount payload; checking which test asserts on it." : "Done. The report is below and went to the parent."}
        </p>
        {c.state === "running" && <span className="crew-bg-dot self-start" aria-label="Working" />}
      </div>
    </div>
  );
}

/** The agent's own composer, or the line that says why there is none. */
export function ThreadFooter({ c }: { c: Case }) {
  const parent = c.crumbs.at(-1)!;
  if (c.writable)
    return (
      <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-4">
        <div className="crew-well flex flex-col gap-2 px-3.5 pt-3 pb-2">
          <span className="text-[14px] text-placeholder">Message {c.title.length > 30 ? "this session" : c.title}…</span>
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <span className="flex h-6 items-center gap-1 rounded-full px-2 ring-1 ring-hairline">
              <ThreadMark c={c} className="size-3" />
              {c.model}
            </span>
            <span className="flex-1" />
            {c.state === "running" ? (
              <span className="grid size-7 place-items-center rounded-full bg-accent text-inverse">
                <SquareIcon className="size-2.5 fill-current" />
              </span>
            ) : (
              <span className="grid size-7 place-items-center rounded-full bg-fill text-placeholder">↑</span>
            )}
          </div>
        </div>
      </div>
    );
  const stoppable = c.state === "running";
  return (
    <div className="mx-auto flex h-11 w-full max-w-[760px] shrink-0 items-center gap-2 px-6 text-[11.5px] text-placeholder">
      <span className="truncate">Read only · its report goes to {parent.name}</span>
      <span className="flex-1" />
      <span className="shrink-0">
        <kbd className="font-sans">esc</kbd> back
        {stoppable && (
          <>
            {" "}
            · <kbd className="font-sans">x</kbd> stop
          </>
        )}
      </span>
    </div>
  );
}

/** The ancestors as ghost buttons, the holder with the back chevron; `mini` shows only the holder. */
export function Path({ c, mini = false, max = "max-w-[140px]" }: { c: Case; mini?: boolean; max?: string }) {
  const crumbs = mini ? c.crumbs.slice(-1) : c.crumbs;
  const last = crumbs.length - 1;
  return (
    <>
      {mini && c.crumbs.length > 1 && <span className="shrink-0 px-0.5 text-[12.5px] text-placeholder">…</span>}
      {crumbs.map((level, index) => (
        <span key={level.id} className={`flex min-w-[52px] items-center gap-1 overflow-hidden ${index === last ? "shrink" : "shrink-[3]"}`}>
          <Button variant="ghost" title={`Back to ${level.name}`} className="h-7 min-w-0 shrink! gap-1.5 overflow-hidden px-1.5 text-[13px] font-normal text-text-muted">
            {index === last && <ChevronLeftIcon className="size-3.5 shrink-0" />}
            <LevelMark level={level} className="size-4 shrink-0" />
            <span className={`${max} truncate`}>{level.name}</span>
          </Button>
          <span className="shrink-0 text-placeholder">/</span>
        </span>
      ))}
    </>
  );
}

export function Title({ c, className = "text-[14px]" }: { c: Case; className?: string }) {
  return (
    <span className="flex min-w-[96px] items-center gap-1.5 pl-1 [flex-shrink:0.5]">
      <ThreadMark c={c} />
      <span className={`truncate leading-5 font-medium ${className}`}>{c.title}</span>
    </span>
  );
}

export function Status({ c, tokens = true }: { c: Case; tokens?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-3 text-[12px] text-text-muted tabular-nums">
      {tokens && c.tokens && <span>{c.tokens}</span>}
      <span className="flex items-center gap-1.5">
        <StateDot state={c.state} />
        <span className="text-text">{stateLabel(c)}</span>
        {c.elapsed}
      </span>
    </span>
  );
}

/** Stop (for a read-only thread that runs) and the esc keycap. */
export function Actions({ c }: { c: Case }) {
  return (
    <>
      {c.state === "running" && !c.writable && (
        <Button variant="ghost" keys="x" className="h-7 px-2 text-[12.5px] font-normal">
          <SquareIcon className="size-2.5 fill-current text-icon" />
          Stop
        </Button>
      )}
      <Kbd keys="esc" />
    </>
  );
}

export function Meta({ c, className = "" }: { c: Case; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-text-muted ${className}`}>
      <span className="truncate">{metaOf(c)}</span>
      {c.branch && (
        <span className="flex min-w-0 shrink items-center gap-1 before:mr-0.5 before:content-['·']">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{c.branch}</span>
        </span>
      )}
    </div>
  );
}
