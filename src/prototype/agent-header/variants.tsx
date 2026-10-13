// PROTOTYPE — throwaway. Ways for a subagent's thread header to read as the
// container of the thread rather than the first line of its transcript.
// "0" is today's header, for comparison.
import { ChevronRightIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Kbd } from "../../chrome/Kbd";
import { StateDot } from "../../surfaces/chat/Panel";
import { metaOf, stateLabel, type Case } from "./data";
import { Actions, Frame, LevelMark, Meta, ParentChat, Path, Status, TabPill, ThreadBody, ThreadFooter, ThreadMark, Title } from "./parts";

const FADE = "[mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]";

/** Today: two lines on the transcript's white, the letter right under them. */
function Today({ c }: { c: Case }) {
  return (
    <Frame c={c}>
      <div className="absolute inset-0 flex flex-col bg-canvas">
        <header className="mx-auto flex w-full max-w-[760px] shrink-0 flex-col gap-0.5 px-6 pt-5 pb-3">
          <div className="flex min-w-0 items-center gap-1">
            <nav className="flex min-w-0 flex-1 items-center gap-1">
              <Path c={c} />
              <Title c={c} className="text-[15px]" />
            </nav>
            <Status c={c} />
            <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
            <Actions c={c} />
          </div>
          <Meta c={c} />
        </header>
        <ThreadBody c={c} top="pt-1" />
        <ThreadFooter c={c} />
      </div>
    </Frame>
  );
}

/**
 * A — Bar. The header becomes chrome: the sidebar's tint, a bottom border,
 * pinned while the transcript scrolls under it. One line holds the path and
 * the state; the facts sit on a quieter second line inside the same band.
 */
function Bar({ c }: { c: Case }) {
  return (
    <Frame c={c}>
      <div className="absolute inset-0 flex flex-col bg-canvas">
        <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-rail">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-0.5 px-4 pt-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <nav className="flex min-w-0 flex-1 items-center gap-1">
                <Path c={c} />
                <Title c={c} />
              </nav>
              <Status c={c} />
              <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
              <Actions c={c} />
            </div>
            <Meta c={c} className="pl-2 text-[11.5px]" />
          </div>
        </header>
        <ThreadBody c={c} />
        <ThreadFooter c={c} />
      </div>
    </Frame>
  );
}

/**
 * B — Sheet. The thread is a sheet laid over the parent's chat, which stays
 * visible above it, dimmed. Each level of nesting leaves one more edge in the
 * stack, so depth reads at a glance. The header is the sheet's top.
 */
function Sheet({ c }: { c: Case }) {
  const depth = c.crumbs.length;
  const edges = c.crumbs.slice(1);
  const top = 44 + 8 * (depth - 1);
  return (
    <Frame c={c}>
      <ParentChat c={c} />
      <div className="absolute inset-0" style={{ background: "light-dark(oklch(0% 0 0 / 0.16), oklch(0% 0 0 / 0.5))" }} />
      {edges.map((level, index) => (
        <div
          key={level.id}
          title={level.name}
          className="absolute inset-x-0 bottom-0 rounded-t-[14px] bg-canvas opacity-80 shadow-float"
          style={{ top: 44 + 8 * index, marginInline: 10 + 6 * (edges.length - index) }}
        />
      ))}
      <div
        className="crew-thread absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[14px] bg-canvas shadow-float"
        style={{ top, marginInline: 10 }}
      >
        <header className="shrink-0 border-b border-hairline">
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-1 px-3 py-2">
            <nav className="flex min-w-0 flex-1 items-center gap-1">
              <Path c={c} />
              <Title c={c} />
            </nav>
            <Status c={c} />
            <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
            <Actions c={c} />
          </div>
        </header>
        <Meta c={c} className="mx-auto w-full max-w-[760px] px-6 pt-3 text-[11.5px]" />
        <ThreadBody c={c} top="pt-3" />
        <ThreadFooter c={c} />
      </div>
    </Frame>
  );
}

/**
 * C — Tab path. The way down lives in the tab strip: the active tab grows
 * into the path, the thread is its last, raised segment. The pane keeps one
 * slim tinted line of facts and the state.
 */
function TabPath({ c }: { c: Case }) {
  const strip = (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 rounded-[12px] bg-card p-0.5 pr-1">
      {c.crumbs.map((level) => (
        <span key={level.id} className="flex min-w-0 shrink-[3] items-center gap-0.5">
          <button type="button" className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-text-muted hover:bg-hover hover:text-text">
            <LevelMark level={level} className="size-3.5 shrink-0" />
            <span className="max-w-[150px] truncate">{level.name}</span>
          </button>
          <ChevronRightIcon className="size-3 shrink-0 text-placeholder" />
        </span>
      ))}
      <TabPill className="h-6 min-w-[120px] shrink">
        <ThreadMark c={c} className="size-3.5" />
        <span className="truncate font-medium">{c.title}</span>
        <StateDot state={c.state} />
      </TabPill>
      <span className="flex-1" />
      <Kbd keys="esc" className="ml-1" />
    </div>
  );
  return (
    <Frame c={c} strip={strip}>
      <div className="absolute inset-0 flex flex-col bg-canvas">
        <div className="shrink-0 border-b border-hairline bg-sidebar">
          <div className="mx-auto flex h-8 w-full max-w-[760px] items-center gap-3 px-6">
            <Meta c={c} className="min-w-0 flex-1 text-[11.5px]" />
            <Status c={c} />
            {c.state === "running" && !c.writable && (
              <span className="text-[11.5px] text-text-muted">
                <kbd className="font-sans">x</kbd> stop
              </span>
            )}
          </div>
        </div>
        <ThreadBody c={c} />
        <ThreadFooter c={c} />
      </div>
    </Frame>
  );
}

/**
 * D — Rail. A tinted rail on the left holds the way down as a stack of marks
 * joined by a line; the open thread's mark sits where its title starts, and
 * the line runs on down beside the transcript: everything right of it belongs
 * to that thread.
 */
function Rail({ c }: { c: Case }) {
  return (
    <Frame c={c}>
      <div className="absolute inset-0 flex bg-canvas">
        <aside className="relative flex w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-sidebar pt-2.5">
          {c.crumbs.map((level) => (
            <button
              key={level.id}
              type="button"
              title={`Back to ${level.name}`}
              className="relative z-10 grid size-6 place-items-center rounded-md bg-sidebar opacity-70 ring-1 ring-hairline hover:opacity-100"
            >
              <LevelMark level={level} className="size-4" />
            </button>
          ))}
          <span className="relative z-10 grid size-7 place-items-center rounded-md bg-canvas shadow-[0_1px_2px_var(--color-hairline)] ring-1 ring-border-strong">
            <ThreadMark c={c} />
          </span>
          <span aria-hidden className="absolute top-6 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border-strong" />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-hairline">
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-0.5 px-5 pt-2.5 pb-2.5" style={{ paddingTop: 30 * c.crumbs.length - 8 }}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[11.5px] text-text-muted">{c.crumbs.map((l) => l.name).join(" / ")} /</span>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-medium">{c.title}</span>
                <Status c={c} />
                <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
                <Actions c={c} />
              </div>
              <Meta c={c} className="text-[11.5px]" />
            </div>
          </header>
          <ThreadBody c={c} />
          <ThreadFooter c={c} />
        </div>
      </div>
    </Frame>
  );
}

/**
 * E — Pill. One floating pill, pinned at the top over the transcript: back
 * to the holder, the thread's name, its state. The transcript fades under it.
 * The facts (kind, model, who it reports to) live in the pill's tooltip and
 * in the handoff letter that opens the thread.
 */
function Pill({ c }: { c: Case }) {
  return (
    <Frame c={c}>
      <div className="absolute inset-0 flex flex-col bg-canvas">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-canvas via-canvas/90 to-transparent" />
        <header className="absolute inset-x-0 top-3 z-20 flex justify-center px-6">
          <div
            title={metaOf(c)}
            className="flex h-9 max-w-full min-w-0 items-center gap-1 rounded-full bg-surface pr-2 pl-1 shadow-float"
          >
            <Path c={c} mini max="max-w-[110px]" />
            <span className="flex min-w-0 shrink overflow-hidden">
              <Title c={c} className="text-[13px]" />
            </span>
            <span className="mx-1.5 h-4 w-px shrink-0 bg-hairline" />
            <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[12px] text-text-muted tabular-nums">
              <StateDot state={c.state} />
              <span className="text-text">{stateLabel(c)}</span>
              {c.elapsed}
            </span>
            <Kbd keys="esc" />
          </div>
        </header>
        <ThreadBody c={c} top="pt-16" className={FADE} />
        <ThreadFooter c={c} />
      </div>
    </Frame>
  );
}

export const VARIANTS: { key: string; name: string; Component: ComponentType<{ c: Case }> }[] = [
  { key: "0", name: "Today", Component: Today },
  { key: "A", name: "Tinted bar", Component: Bar },
  { key: "B", name: "Sheet over the parent", Component: Sheet },
  { key: "C", name: "Path in the tab strip", Component: TabPath },
  { key: "D", name: "Left rail", Component: Rail },
  { key: "E", name: "Floating pill", Component: Pill },
];
