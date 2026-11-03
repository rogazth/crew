import { Tabs } from "@base-ui/react/tabs";
import { ChevronLeftIcon, ChevronRightIcon, GitBranchIcon, GlobeIcon, HatGlassesIcon, LoaderCircleIcon, LayersIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionMenu } from "./ActionMenu";
import { BranchTag } from "./BranchDot";
import { BotAvatar } from "./BotAvatar";
import { TOGGLE_RESERVE } from "../lib/chrome";
import { DriverFace } from "./DriverFace";
import { FileTypeIcon } from "./FileTypeIcon";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { StubIcon } from "./StubIcon";
import { TabLauncher, type Launch } from "./TabLauncher";
import { useLease } from "../hooks/useBrowserLeases";
import { TabPeek, type PeekAnchor } from "./TabPeek";
import { toneOf } from "../lib/tabStyle";
import { useBrowserPage } from "../hooks/useBrowserPage";
import { useCommand } from "../hooks/useCommand";
import { useFileDrop } from "../hooks/useFileDrop";
import { useTabDrag } from "../hooks/useTabDrag";
import { useTabOverflow } from "../hooks/useTabOverflow";
import { useTabBackground } from "../hooks/useBackground";
import { commandKeys } from "../lib/commands";
import {
  CLOSE_OTHERS,
  CLOSE_RIGHT,
  CLOSE_TAB,
  CLOSE_WORKTREE,
  COLLAPSE_OTHERS,
  COLLAPSE_WORKTREE,
  COPY_PATH,
  COPY_URL,
  EDIT,
  EXPAND_WORKTREE,
  PIN_TAB,
  REOPEN_TAB,
  SEPARATOR,
  UNPIN_TAB,
  menuFromEvent,
  tidy,
  type MenuEntry,
  type MenuPoint,
} from "../lib/menu";
import { browserTitle, isIncognitoTab, tabTitle } from "../lib/tabs";
import { itemOrder, stripItems, type PlaceOf, type StripItem } from "../lib/tabGroups";
import type { Session, SessionStatus, Tab } from "../lib/types";

type Branch = { label: string; hue: number };

/**
 * All together, with worktrees to tell apart: whose each tab is, its tag, and
 * folding a worktree's tabs into one chip.
 */
export type TabGroups = {
  placeOf: PlaceOf;
  labelOf: (place: string) => Branch | null;
  collapsed: string[];
  onCollapse: (place: string, at: string) => void;
  onCollapseOthers: (place: string) => void;
  onExpand: (place: string) => void;
};

type Props = {
  /** With the sidebar hidden, the traffic lights land on this strip. */
  inset: boolean;
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseMany: (ids: string[]) => void;
  onReopen: () => void;
  onEditSession: (session: Session) => void;
  onReorder: (ids: string[]) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onLaunch: (launch: Launch) => void;
  /** Said on the strip while the sidebar is away: where you are, in the worktree's hue, and the door to switch. */
  context: { workspace: string; branch: string; hue?: number | undefined; onSwitch: () => void };
  groups: TabGroups | null;
  /** The branch a session works on, from its worktree; null when it has none to name. */
  branchOfSession?: ((session: Session) => string | null) | undefined;
  /** Files dropped on the strip from Finder, each to open in a tab. */
  onDropFiles: (paths: string[]) => void;
};

type GroupItem = Extract<StripItem, { kind: "group" }>;

type Menu = { point: MenuPoint } & ({ tab: Tab; group?: never } | { group: GroupItem; tab?: never });

/** The tabs "Close Other Tabs" takes: every unpinned one but `tab`. */
const othersOf = (tab: Tab, tabs: Tab[]) => tabs.flatMap((t) => (t.id !== tab.id && !t.pinned ? [t.id] : []));

/** The tabs "Close Tabs to the Right" takes: the unpinned ones past `tab`. */
const rightOf = (tab: Tab, tabs: Tab[]) =>
  tabs.slice(tabs.findIndex((t) => t.id === tab.id) + 1).flatMap((t) => (t.pinned ? [] : [t.id]));

/**
 * Folding a worktree needs a tab left to show: with the one on screen among
 * its tabs and nothing else in view, it stays open.
 */
function canCollapse(place: string, tabs: Tab[], activeId: string | null, groups: TabGroups): boolean {
  const folded = new Set(groups.collapsed);
  const own = (tab: Tab) => !tab.pinned && groups.placeOf(tab) === place;
  if (!tabs.some((tab) => tab.id === activeId && own(tab))) return true;
  return tabs.some((tab) => {
    if (own(tab)) return false;
    const other = tab.pinned ? null : groups.placeOf(tab);
    return other === null || !folded.has(other);
  });
}

/** What a tab's right-click offers: what it holds, pinning, folding its worktree, closing around it, and getting one back. */
function tabActions(
  tab: Tab,
  tabs: Tab[],
  sessions: Session[],
  activeId: string | null,
  groups: TabGroups | null,
): MenuEntry[] {
  const session = tab.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
  const place = !tab.pinned && groups ? groups.placeOf(tab) : null;
  const places = new Set(groups ? tabs.flatMap((t) => (t.pinned ? [] : [groups.placeOf(t)])) : []);
  const folded = new Set(groups?.collapsed);
  return tidy([
    ...(session?.kind === "bot" ? [EDIT] : []),
    ...(tab.kind === "file" ? [COPY_PATH] : []),
    ...(tab.kind === "browser" && tab.url ? [COPY_URL] : []),
    SEPARATOR,
    tab.pinned ? UNPIN_TAB : PIN_TAB,
    ...(place !== null && groups
      ? [
          { ...COLLAPSE_WORKTREE, disabled: !canCollapse(place, tabs, activeId, groups) },
          {
            ...COLLAPSE_OTHERS,
            disabled: [...places].every((other) => other === null || other === place || folded.has(other)),
          },
        ]
      : []),
    SEPARATOR,
    CLOSE_TAB,
    { ...CLOSE_OTHERS, disabled: othersOf(tab, tabs).length === 0 },
    { ...CLOSE_RIGHT, disabled: rightOf(tab, tabs).length === 0 },
    SEPARATOR,
    REOPEN_TAB,
  ]);
}

/** One 40px row of pill tabs, plus on the end. Every slot in a pill is fixed width. */
export function TabBar({
  inset,
  tabs,
  activeId,
  sessions,
  onSelect,
  onClose,
  onCloseMany,
  onReopen,
  onEditSession,
  onReorder,
  onPin,
  onUnpin,
  onLaunch,
  context,
  groups,
  branchOfSession,
  onDropFiles,
}: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const dropping = useFileDrop(bar, onDropFiles);
  const [launcher, setLauncher] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  // A tab held still under the pointer for a beat shows what its session is doing.
  const [peek, setPeek] = useState<{ tabId: string; anchor: PeekAnchor } | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const onPeek = useCallback((tabId: string, el: HTMLElement | null) => {
    window.clearTimeout(peekTimer.current);
    if (!el || document.documentElement.dataset.tabDragging !== undefined) return setPeek(null);
    peekTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setPeek({ tabId, anchor: { left: Math.min(rect.left, window.innerWidth - 312), top: rect.bottom + 6 } });
    }, 450);
  }, []);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  // The shell's close is remade with every tab and session; the pills get one
  // that is not, so a tab opened does not redraw every pill in the strip.
  const latestClose = useRef(onClose);
  useLayoutEffect(() => {
    latestClose.current = onClose;
  });
  const closePill = useCallback((id: string) => latestClose.current(id), []);
  const pinned = tabs.filter((tab) => tab.pinned);
  const pinnedIds = pinned.map((tab) => tab.id);
  const items = stripItems(
    tabs.filter((tab) => !tab.pinned),
    groups?.collapsed ?? [],
    groups?.placeOf ?? null,
  );
  const itemIds = items.map((item) => (item.kind === "tab" ? item.tab.id : item.id));
  // A pill slides along its own run, pinned or not; the strip scrolls under it.
  useTabDrag(bar, {
    onReorder: (group, next) =>
      onReorder(group === "pins" ? [...next, ...tabs.flatMap((tab) => (tab.pinned ? [] : [tab.id]))] : [...pinnedIds, ...itemOrder(next, items)]),
    onStart: () => onPeek("", null),
  });
  const { ref, endRef, overflowing, canScrollStart, canScrollEnd, scroll } = useTabOverflow(itemIds.join("|"));
  const branchOf = (tab: Tab): Branch | null => {
    const place = groups?.placeOf(tab);
    return place ? groups!.labelOf(place) : null;
  };

  useCommand("open-launcher", () => setLauncher((value) => !value));

  // Selecting from the launcher or the sidebar can land on a tab that scrolled out of view.
  // Brought in sideways only: the strip never scrolls up or down, whatever a tab's height.
  useEffect(() => {
    const scroller = ref.current;
    const el = activeId ? scroller?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`) : null;
    if (!scroller || !el) return;
    const margin = 40;
    const box = scroller.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    if (tab.left < box.left + margin) scroller.scrollLeft -= box.left + margin - tab.left;
    else if (tab.right > box.right - margin) scroller.scrollLeft += tab.right - (box.right - margin);
  }, [activeId, ref]);

  return (
    <div
      ref={bar}
      data-tauri-drag-region
      data-file-drop={dropping || undefined}
      className={`flex h-10 shrink-0 items-stretch border-b border-transparent ${
        // Files held over the strip only tint it; they open as tabs.
        dropping ? "bg-[color-mix(in_oklab,var(--color-focus)_6%,var(--color-sidebar))]" : "bg-sidebar"
      }`}
    >
      {inset && (
        <div data-tab-inset className="flex shrink-0 items-center">
          <div className={`shrink-0 ${TOGGLE_RESERVE}`} />
          <button
            type="button"
            data-tauri-drag-region="false"
            title={`Switch workspace ${commandKeys("switch-workspace")}`}
            onClick={context.onSwitch}
            className="mx-1 flex h-7 shrink-0 translate-y-px items-center gap-1.5 rounded-md px-2 text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
          >
            <span className="font-medium text-text">{context.workspace}</span>
            {context.branch && <span>›</span>}
            {context.branch && <GitBranchIcon className="size-3.5" />}
            {context.branch && <span>{context.branch}</span>}
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        </div>
      )}
      <Tabs.Root
        value={activeId}
        onValueChange={(value) => onSelect(String(value))}
        className="flex min-w-0 flex-1 items-center"
      >
        <Tabs.List className="flex h-full min-w-0 flex-1 items-center">
          {pinned.length > 0 && (
            <div data-tab-pins data-drag-group="pins" className="flex h-full shrink-0 items-center gap-0.5 pl-2.5">
                {pinned.map((tab) => (
                  <PinnedPill
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeId}
                    sessions={sessions}
                    onClose={closePill}
                    onMenu={setMenu}
                    branch={branchOf(tab)}
                    onPeek={onPeek}
                  />
                ))}
              <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-border" />
            </div>
          )}

          <div className="relative isolate flex h-full min-w-0 flex-1">
            {/* One scroller carries the tabs and the plus, so the plus trails the last
                tab and sits flush left when there are none. Overflowing, it is no window
                handle: a wheel in a gap between tabs scrolls them. */}
            <div
              ref={ref}
              data-tab-strip
              data-drag-group="strip"
              data-tauri-drag-region={overflowing ? "false" : undefined}
              className={`no-scrollbar flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden pr-1.5 scroll-px-10 ${pinned.length > 0 ? "" : "pl-2.5"}`}
            >
                {items.map((item) =>
                  item.kind === "tab" ? (
                    <TabPill
                      key={item.tab.id}
                      tab={item.tab}
                      active={item.tab.id === activeId}
                      sessions={sessions}
                      onClose={closePill}
                      onMenu={setMenu}
                      branch={branchOf(item.tab)}
                      onPeek={onPeek}
                    />
                  ) : (
                    <GroupChip
                      key={item.id}
                      item={item}
                      branch={groups?.labelOf(item.place) ?? null}
                      sessions={sessions}
                      onExpand={groups?.onExpand ?? NO_EXPAND}
                      onMenu={setMenu}
                    />
                  ),
                )}

              <div className="ml-1 flex shrink-0 items-center">
                <TabLauncher
                  open={launcher}
                  onOpenChange={setLauncher}
                  sessions={sessions}
                  onLaunch={onLaunch}
                />
              </div>
              {/* The strip's end: once it is in view, so is the plus, and the end arrow goes. */}
              <span ref={endRef} aria-hidden className="h-px w-px shrink-0" />
            </div>

            <ScrollControl
              side="start"
              visible={canScrollStart}
              onClick={() => scroll("start")}
            />
            <ScrollControl
              side="end"
              visible={canScrollEnd}
              onClick={() => scroll("end")}
            />
          </div>
        </Tabs.List>
      </Tabs.Root>

      {peek && !menu && (
        <PeekFor
          tabId={peek.tabId}
          anchor={peek.anchor}
          tabs={tabs}
          sessions={sessions}
          branchOf={(tab, session) => branchOf(tab)?.label ?? branchOfSession?.(session) ?? null}
        />
      )}

      {menu?.group && (
        <ActionMenu
          key={menu.group.id}
          point={menu.point}
          title={groups?.labelOf(menu.group.place)?.label ?? "Worktree"}
          actions={[EXPAND_WORKTREE, SEPARATOR, CLOSE_WORKTREE]}
          onPick={(id) => {
            const group = menu.group;
            setMenu(null);
            if (id === "expand") groups?.onExpand(group.place);
            if (id === "close-group") onCloseMany(group.tabs.map((tab) => tab.id));
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {menu?.tab && (
        <ActionMenu
          key={menu.tab.id}
          point={menu.point}
          title={tabTitle(menu.tab, sessions)}
          actions={tabActions(menu.tab, tabs, sessions, activeId, groups)}
          onPick={(id) => {
            const tab = menu.tab;
            setMenu(null);
            const place = groups?.placeOf(tab) ?? null;
            if (id === "close") onClose(tab.id);
            if (id === "close-others") onCloseMany(othersOf(tab, tabs));
            if (id === "close-right") onCloseMany(rightOf(tab, tabs));
            if (id === "pin") onPin(tab.id);
            if (id === "unpin") onUnpin(tab.id);
            if (id === "collapse" && place) groups?.onCollapse(place, tab.id);
            if (id === "collapse-others" && place) groups?.onCollapseOthers(place);
            if (id === "copy-path" && tab.kind === "file") void navigator.clipboard.writeText(tab.path);
            if (id === "copy-url" && tab.kind === "browser") void navigator.clipboard.writeText(tab.url);
            if (id === "reopen") onReopen();
            if (id === "edit" && tab.kind === "session") {
              const session = sessions.find((s) => s.id === tab.sessionId);
              if (session) onEditSession(session);
            }
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * A pill drags along the strip only (useTabDrag). Nothing re-renders while it
 * is held: the strip re-renders once, on drop, when the new order is saved.
 */
const TabPill = memo(function TabPill({
  tab,
  active,
  sessions,
  onClose,
  onMenu,
  branch,
  onPeek,
}: {
  tab: Tab;
  active: boolean;
  sessions: Session[];
  onClose: (id: string) => void;
  onMenu: (menu: Menu) => void;
  branch: Branch | null;
  onPeek: (tabId: string, el: HTMLElement | null) => void;
}) {
  const status = tabStatus(tab, sessions);
  // A turn that ended with commands still running: their count beside the title.
  const background = useTabBackground(tab.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined);
  const tone = toneOf(status);
  const signal = status !== null && status !== "idle" && status !== "exited";
  return (
    <Tabs.Tab
      value={tab.id}
      nativeButton={false}
      render={<div />}
      data-tab-id={tab.id}
      data-drag-id={tab.id}
      data-incognito={isIncognitoTab(tab) || undefined}
      data-tauri-drag-region="false"
      onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
      onContextMenu={(event) => {
        onPeek(tab.id, null);
        onMenu({ point: menuFromEvent(event), tab });
      }}
      onMouseEnter={(event) => tab.kind === "session" && onPeek(tab.id, event.currentTarget)}
      onMouseLeave={() => onPeek(tab.id, null)}
      onPointerDown={() => onPeek(tab.id, null)}
      title={tab.kind === "session" ? undefined : tabTitle(tab, sessions)}
      /* The card (crew-tab in index.css) marks the one on screen. */
      data-on={active || undefined}
      className={`crew-tab group w-fit ${branch ? "max-w-[240px]" : "max-w-[190px]"} shrink-0 touch-none gap-1 pr-1 pl-2.5 ${
        active ? "text-text" : "text-text-muted"
      }`}
    >
      {tab.kind === "browser" ? (
        <BrowserTabFace tab={tab} sessions={sessions} />
      ) : (
        <>
          <TabIcon tab={tab} sessions={sessions} />
          {/* Laid over its own bold copy, so turning bold for news never resizes the tab. */}
          <span data-text={tabTitle(tab, sessions)} className="crew-steady-title flex-1">
            <span className={tone.bold ? "font-semibold text-text" : undefined}>{tabTitle(tab, sessions)}</span>
          </span>
          <BackgroundCount count={background} />
        </>
      )}
      {branch && <BranchTag hue={branch.hue} label={branch.label} className="max-w-[110px]" />}
      {/* One fixed slot holds the status and the close button, so neither resizes the
          tab: the status shows until a hover or a focus asks for the button. */}
      <span className="relative -ml-0.5 flex size-5 shrink-0 items-center justify-center">
        {signal && (
          <StatusDot
            status={status}
            className="transition-opacity duration-150 group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
          />
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          aria-label="Close tab"
          className={`absolute right-0 flex size-5 items-center justify-center rounded-full text-text-muted transition-[color,background-color,opacity] hover:bg-selected hover:text-text focus-visible:opacity-100 ${
            active && !signal ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </Tabs.Tab>
  );
}, samePill);

/**
 * A pinned tab is its face alone, the title in its tooltip. It keeps no close
 * button; the middle click, the menu and the keyboard still close it.
 */
const PinnedPill = memo(function PinnedPill({
  tab,
  active,
  sessions,
  onClose,
  onMenu,
  branch,
  onPeek,
}: {
  tab: Tab;
  active: boolean;
  sessions: Session[];
  onClose: (id: string) => void;
  onMenu: (menu: Menu) => void;
  branch: Branch | null;
  onPeek: (tabId: string, el: HTMLElement | null) => void;
}) {
  const status = tabStatus(tab, sessions);
  const title = tabTitle(tab, sessions);
  return (
    <Tabs.Tab
      value={tab.id}
      nativeButton={false}
      render={<div />}
      data-tab-id={tab.id}
      data-drag-id={tab.id}
      data-incognito={isIncognitoTab(tab) || undefined}
      data-tauri-drag-region="false"
      aria-label={title}
      onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
      onContextMenu={(event) => {
        onPeek(tab.id, null);
        onMenu({ point: menuFromEvent(event), tab });
      }}
      onMouseEnter={(event) => tab.kind === "session" && onPeek(tab.id, event.currentTarget)}
      onMouseLeave={() => onPeek(tab.id, null)}
      onPointerDown={() => onPeek(tab.id, null)}
      title={tab.kind === "session" ? undefined : title}
      data-on={active || undefined}
      className="crew-tab w-8 shrink-0 touch-none justify-center"
    >
      {tab.kind === "browser" ? (
        <BrowserTabFace tab={tab} sessions={sessions} bare />
      ) : (
        <TabIcon tab={tab} sessions={sessions} />
      )}
      {/* No title, no slot: the status rides the pill's corner. */}
      {status && (
        <span className="pointer-events-none absolute -top-1 -right-1 flex rounded-full bg-sidebar empty:hidden">
          <StatusDot status={status} className="size-3" />
        </span>
      )}
      {branch && (
        <span
          aria-hidden
          className="absolute bottom-0.5 left-1/2 h-0.5 w-2.5 -translate-x-1/2 rounded-full"
          style={{ background: `oklch(68% 0.14 ${branch.hue})` }}
        />
      )}
    </Tabs.Tab>
  );
}, samePill);

const NO_EXPAND = () => {};

/** What a folded worktree says of its sessions: the one most in need of you. */
const URGENCY: SessionStatus[] = ["needs-input", "error", "done", "working", "background"];

function groupStatus(tabs: Tab[], sessions: Session[]): SessionStatus | null {
  const statuses = new Set(tabs.map((tab) => tabStatus(tab, sessions)));
  return URGENCY.find((status) => statuses.has(status)) ?? null;
}

/**
 * A worktree's tabs folded into one tag: its branch and how many it holds.
 * A click unfolds them. Its dot carries the loudest status inside, so a
 * session waiting on you is never folded out of sight.
 */
const GroupChip = memo(function GroupChip({
  item,
  branch,
  sessions,
  onExpand,
  onMenu,
}: {
  item: GroupItem;
  branch: Branch | null;
  sessions: Session[];
  onExpand: (place: string) => void;
  onMenu: (menu: Menu) => void;
}) {
  const status = groupStatus(item.tabs, sessions);
  const hue = branch?.hue ?? 0;
  const label = branch?.label ?? "Worktree";
  const count = item.tabs.length;
  return (
    <button
      type="button"
      data-drag-id={item.id}
      data-tauri-drag-region="false"
      aria-label={`${label}, ${count} ${count === 1 ? "tab" : "tabs"}, collapsed`}
      aria-expanded={false}
      title={`Expand ${label}`}
      onClick={() => onExpand(item.place)}
      onContextMenu={(event) => onMenu({ point: menuFromEvent(event), group: item })}
      style={{ background: `oklch(68% 0.14 ${hue} / 0.18)` }}
      className="flex h-6 max-w-[160px] shrink-0 touch-none items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-text outline-none transition-[filter,box-shadow] duration-150 hover:brightness-110 focus-visible:ring-1 focus-visible:ring-hairline"
    >
      <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-text-muted tabular-nums">{count}</span>
      {status && <StatusDot status={status} className="size-3" />}
    </button>
  );
});

/** The strip's overflow affordance: a gradient over the strip's edge with a caret on top. */
function ScrollControl({
  side,
  visible,
  onClick,
}: {
  side: "start" | "end";
  visible: boolean;
  onClick: () => void;
}) {
  const start = side === "start";
  const Caret = start ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-label={start ? "Scroll tabs left" : "Scroll tabs right"}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={onClick}
      data-tauri-drag-region="false"
      className={`absolute inset-y-0 z-10 flex w-10 items-center transition-opacity duration-150 ${
        start ? "left-0 justify-start bg-linear-to-r" : "right-0 justify-end bg-linear-to-l"
      } from-sidebar via-sidebar/95 to-transparent ${
        visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <span className="flex size-6 items-center justify-center text-icon">
        <Caret className="size-3.5" />
      </span>
    </button>
  );
}

/** How many commands a finished turn left running, beside the title. */
function BackgroundCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span aria-label={`${count} background ${count === 1 ? "command" : "commands"} running`} className="shrink-0 text-[11px] text-text-muted tabular-nums">
      {count}
    </span>
  );
}

type PillProps = { tab: Tab; sessions: Session[] } & Record<string, unknown>;

/**
 * A pill reads one row of the session list, its own session's; a page's reads
 * whichever session drives it. A session made or changed anywhere else leaves
 * it as it is: with a hundred tabs open, each ⌘N would otherwise redraw them all.
 */
function samePill(prev: PillProps, next: PillProps): boolean {
  for (const key of Object.keys(next)) if (key !== "sessions" && prev[key] !== next[key]) return false;
  if (prev.sessions === next.sessions) return true;
  const { tab } = next;
  if (tab.kind === "browser") return false;
  if (tab.kind !== "session") return true;
  const row = (list: Session[]) => list.find((s) => s.id === tab.sessionId);
  return row(prev.sessions) === row(next.sessions);
}

const tabStatus = (tab: Tab, sessions: Session[]) =>
  tab.kind === "session"
    ? (sessions.find((s) => s.id === tab.sessionId)?.status ?? null)
    : null;

/** Identity only — the status light lives in the tab's trailing slot. Every branch
    fills the same 14px box, so a tab keeps its layout when its kind changes. */
function TabIcon({ tab, sessions }: { tab: Tab; sessions: Session[] }) {
  const icon = () => {
    if (tab.kind === "stub") return <StubIcon stub={tab.stub} className="size-3.5 text-icon" />;
    if (tab.kind === "file") return <FileTypeIcon name={tab.relative} className="size-3.5" />;
    if (tab.kind === "process") return <LayersIcon className="size-3.5 text-icon" />;
    if (tab.kind === "browser")
      return tab.incognito ? <IncognitoIcon /> : <GlobeIcon className="size-3.5 text-icon" />;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session) return null;
    return session.kind === "bot" ? (
      <BotAvatar seed={session.id} bare className="size-3.5" />
    ) : (
      <ProviderIcon provider={session.provider} className="size-3.5" />
    );
  };
  return (
    <span className="grid size-3.5 shrink-0 place-items-center">{icon()}</span>
  );
}

/**
 * A page's pill reads its live state, so a navigation re-renders this pill and
 * nothing else in the strip. A cold page has no live state yet and falls back
 * to what its tab saved.
 */
function BrowserTabFace({
  tab,
  sessions,
  bare = false,
}: {
  tab: Extract<Tab, { kind: "browser" }>;
  sessions: Session[];
  bare?: boolean;
}) {
  const page = useBrowserPage(tab.id);
  const lease = useLease(tab.id);
  const driver = lease?.sessionId ? sessions.find((s) => s.id === lease.sessionId) : undefined;
  // A page that hasn't named itself yet (a cold tab mounting, a file) keeps the name its tab saved.
  const named = page.webContentsId !== null && page.title.trim() !== "";
  const title = named ? browserTitle(page.title, page.url) : browserTitle(tab.title, tab.url);
  return (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <PageIcon tab={tab} loading={page.loading} favicon={page.favicon} />
      </span>
      {!bare && <span className="min-w-0 flex-1 truncate">{title}</span>}
      {/* Whoever drives the page shows on the tab; the page's own bar has the way to take it back. */}
      {lease && driver && (
        <span title={`${lease.holder} is using this page`} className="flex shrink-0 items-center" data-tab-driver={lease.holder}>
          <DriverFace session={driver} className="size-3.5" />
        </span>
      )}
    </>
  );
}

function PageIcon({
  tab,
  loading,
  favicon,
}: {
  tab: Extract<Tab, { kind: "browser" }>;
  loading: boolean;
  favicon: string | null;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const icon = favicon && favicon !== broken ? favicon : null;
  if (loading) return <LoaderCircleIcon className="size-3.5 animate-spin text-icon" />;
  // Pages of both kinds share the strip, so the private one wears its mark instead of the site's.
  if (tab.incognito) return <IncognitoIcon />;
  if (tab.file) return <FileTypeIcon name={tab.file.relative} className="size-3.5" />;
  if (icon) return <img src={icon} alt="" data-favicon className="size-3.5" onError={() => setBroken(icon)} />;
  return <GlobeIcon className="size-3.5 text-icon" />;
}

function IncognitoIcon() {
  return <HatGlassesIcon role="img" aria-label="Incognito" className="size-3.5 text-text" />;
}

/** The hover card for whichever tab asked, if it still holds a session. */
function PeekFor({
  tabId,
  anchor,
  tabs,
  sessions,
  branchOf,
}: {
  tabId: string;
  anchor: PeekAnchor;
  tabs: Tab[];
  sessions: Session[];
  branchOf: (tab: Tab, session: Session) => string | null;
}) {
  const tab = tabs.find((t) => t.id === tabId);
  const session = tab?.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
  if (!tab || !session) return null;
  return <TabPeek session={session} branch={branchOf(tab, session)} anchor={anchor} />;
}
