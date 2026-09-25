import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { useSortable } from "@dnd-kit/react/sortable";
import { Tabs } from "@base-ui/react/tabs";
import { CaretLeftIcon, CaretRightIcon, CircleNotchIcon, GitBranchIcon, GlobeIcon } from "@phosphor-icons/react";
import { memo, useEffect, useState } from "react";
import { ActionMenu } from "./ActionMenu";
import { BranchDot } from "./BranchDot";
import { AgentAvatar } from "./AgentAvatar";
import { TOGGLE_RESERVE } from "../lib/chrome";
import { X } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { ProviderIcon } from "./ProviderIcon";
import { SortableList } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { StubIcon } from "./StubIcon";
import { TabLauncher, type Launch } from "./TabLauncher";
import { useBrowserPage } from "../hooks/useBrowserPage";
import { useCommand } from "../hooks/useCommand";
import { useTabOverflow } from "../hooks/useTabOverflow";
import { commandKeys } from "../lib/commands";
import {
  CLOSE_OTHERS,
  CLOSE_RIGHT,
  CLOSE_TAB,
  COPY_PATH,
  COPY_URL,
  EDIT,
  REOPEN_TAB,
  SEPARATOR,
  menuFromEvent,
  tidy,
  type MenuEntry,
  type MenuPoint,
} from "../lib/menu";
import { browserTitle, tabTitle } from "../lib/tabs";
import type { Session, Tab } from "../lib/types";

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
  onLaunch: (launch: Launch) => void;
  /** Said on the strip while the sidebar is away: where you are, and the door to switch. */
  context: { workspace: string; branch: string; onSwitch: () => void };
  /** With every worktree's tabs on one strip, each pill says whose it is. */
  branchOf: ((tab: Tab) => { label: string; hue: number } | null) | null;
};

/** Stable across renders, so the memoised pills are not redrawn for a missing chip. */
const NO_BRANCH = () => null;

type Menu = { point: MenuPoint; tab: Tab };

/** What a tab's right-click offers: what it holds, closing around it, and getting one back. */
function tabActions(tab: Tab, tabs: Tab[], sessions: Session[]): MenuEntry[] {
  const index = tabs.findIndex((t) => t.id === tab.id);
  const session = tab.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
  return tidy([
    ...(session?.kind === "agent" ? [EDIT] : []),
    ...(tab.kind === "file" ? [COPY_PATH] : []),
    ...(tab.kind === "browser" && tab.url ? [COPY_URL] : []),
    SEPARATOR,
    CLOSE_TAB,
    { ...CLOSE_OTHERS, disabled: tabs.length < 2 },
    { ...CLOSE_RIGHT, disabled: index === tabs.length - 1 },
    SEPARATOR,
    REOPEN_TAB,
  ]);
}

/** A pill slides along the strip and stops at its ends; the strip scrolls under it. */
const STRIP_MODIFIERS = [
  RestrictToHorizontalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[data-tab-strip]") ?? null,
  }),
];

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
  onLaunch,
  context,
  branchOf,
}: Props) {
  const [launcher, setLauncher] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const ids = tabs.map((tab) => tab.id);
  const strip = useTabOverflow(ids.join("|"));

  useCommand("open-launcher", () => setLauncher((value) => !value));

  // Selecting from the launcher or the sidebar can land on a tab that scrolled out of view.
  const { ref } = strip;
  useEffect(() => {
    if (!activeId) return;
    ref.current
      ?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, ref]);

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-stretch border-b border-border bg-sidebar"
    >
      {inset && (
        <div className="flex shrink-0 items-center">
          <div className={`shrink-0 ${TOGGLE_RESERVE}`} />
          <button
            type="button"
            data-tauri-drag-region="false"
            title={`Switch ${commandKeys("switch-workspace")}`}
            onClick={context.onSwitch}
            className="mx-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-kumo-subtle outline-none transition-colors hover:bg-hover hover:text-kumo-default focus-visible:bg-hover"
          >
            <span className="font-medium text-kumo-default">{context.workspace}</span>
            <span>›</span>
            <GitBranchIcon className="size-3.5" />
            <span>{context.branch}</span>
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        </div>
      )}
      <Tabs.Root
        value={activeId}
        onValueChange={(value) => onSelect(String(value))}
        className="relative isolate flex min-w-0 flex-1 items-center"
      >
        {/* One scroller carries the tabs and the plus, so the plus trails the last
            tab and sits flush left when there are none. */}
        <div
          ref={ref}
          data-tab-strip
          className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-1.5 scroll-px-10"
        >
          <Tabs.List className="flex h-full shrink-0 items-center gap-1">
            <SortableList ids={ids} onReorder={onReorder} modifiers={STRIP_MODIFIERS}>
              {tabs.map((tab, index) => (
                <TabPill
                  key={tab.id}
                  tab={tab}
                  index={index}
                  active={tab.id === activeId}
                  sessions={sessions}
                  onClose={onClose}
                  onMenu={setMenu}
                  branch={(branchOf ?? NO_BRANCH)(tab)}
                />
              ))}
            </SortableList>
          </Tabs.List>

          <div className="flex shrink-0 items-center">
            <TabLauncher
              open={launcher}
              onOpenChange={setLauncher}
              sessions={sessions}
              onLaunch={onLaunch}
            />
          </div>
        </div>

        <ScrollControl
          side="start"
          visible={strip.canScrollStart}
          onClick={() => strip.scroll("start")}
        />
        <ScrollControl
          side="end"
          visible={strip.canScrollEnd}
          onClick={() => strip.scroll("end")}
        />
      </Tabs.Root>

      {menu && (
        <ActionMenu
          key={menu.tab.id}
          point={menu.point}
          title={tabTitle(menu.tab, sessions)}
          actions={tabActions(menu.tab, tabs, sessions)}
          onPick={(id) => {
            const tab = menu.tab;
            setMenu(null);
            const index = tabs.findIndex((t) => t.id === tab.id);
            if (id === "close") onClose(tab.id);
            if (id === "close-others") onCloseMany(ids.filter((other) => other !== tab.id));
            if (id === "close-right") onCloseMany(ids.slice(index + 1));
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
 * A pill drags along the strip only. dnd-kit moves the DOM while it is held, so
 * the strip re-renders once, on drop, when the new order is saved.
 */
const TabPill = memo(function TabPill({
  tab,
  index,
  active,
  sessions,
  onClose,
  onMenu,
  branch,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  sessions: Session[];
  onClose: (id: string) => void;
  onMenu: (menu: Menu) => void;
  branch: { label: string; hue: number } | null;
}) {
  const { ref, isDragging } = useSortable({
    id: tab.id,
    index,
    group: "tabs",
    type: "tab",
    accept: "tab",
  });
  const status = tabStatus(tab, sessions);
  return (
    <Tabs.Tab
      ref={ref}
      value={tab.id}
      nativeButton={false}
      render={<div />}
      data-tab-id={tab.id}
      data-tauri-drag-region="false"
      onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
      onContextMenu={(event) => onMenu({ point: menuFromEvent(event), tab })}
      title={tabTitle(tab, sessions)}
      /* The ring and the shadow are always drawn; only their colour moves,
         so the pill fades in instead of growing an edge. A held pill wears the
         active face: the inactive one is translucent and would show its neighbours. */
      className={`group relative flex h-7 touch-none w-fit ${branch ? "max-w-[240px]" : "max-w-[190px]"} min-w-[120px] shrink-0 items-center gap-1.5 rounded-chrome pr-1.5 pl-2.5 shadow-[0_1px_2px_var(--tab-shadow)] ring-1 outline-none transition-[color,background-color,box-shadow] duration-150 ${
        active || isDragging
          ? "bg-canvas text-text ring-hairline [--tab-shadow:var(--color-hairline)]"
          : "bg-card text-text-muted ring-transparent hover:bg-hover [--tab-shadow:transparent]"
      } ${isDragging ? "cursor-grabbing" : ""}`}
    >
      {tab.kind === "browser" ? (
        <BrowserTabFace tab={tab} />
      ) : (
        <>
          <TabIcon tab={tab} sessions={sessions} />
          <span className="min-w-0 flex-1 truncate">{tabTitle(tab, sessions)}</span>
        </>
      )}
      {branch && (
        <span className="flex max-w-[70px] shrink-0 items-center gap-1 text-[11px] text-text-muted">
          <BranchDot hue={branch.hue} className="size-1.5" />
          <span className="truncate">{branch.label}</span>
        </span>
      )}
      {/* One fixed slot for two things that never coexist: the status light
          and the close button it yields to on hover. Stacked, so the swap
          never resizes the tab. */}
      <span className="relative flex h-5 w-6 shrink-0 items-center justify-end">
        {status && (
          <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover:opacity-0">
            <StatusDot status={status} />
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          aria-label="Close tab"
          className={`absolute right-0 flex size-5 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-selected hover:text-text focus-visible:opacity-100 ${
            active && !status ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <X className="size-3" />
        </button>
      </span>
    </Tabs.Tab>
  );
});

/** kumo's Tabs overflow affordance: a gradient over the strip's edge with a caret on top. */
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
  const Caret = start ? CaretLeftIcon : CaretRightIcon;
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
      <span className="flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-hover hover:text-text">
        <Caret className="size-3.5" />
      </span>
    </button>
  );
}

const tabStatus = (tab: Tab, sessions: Session[]) =>
  tab.kind === "session"
    ? (sessions.find((s) => s.id === tab.sessionId)?.status ?? null)
    : null;

/** Identity only — the status light lives in the tab's trailing slot. Every branch
    fills the same 14px box, so a tab keeps its layout when its kind changes. */
function TabIcon({ tab, sessions }: { tab: Tab; sessions: Session[] }) {
  const icon = () => {
    if (tab.kind === "stub") return <StubIcon stub={tab.stub} className="size-3.5 text-text-muted" />;
    if (tab.kind === "file") return <FileTypeIcon name={tab.relative} className="size-3.5" />;
    if (tab.kind === "browser") return <GlobeIcon className="size-3.5 text-text-muted" />;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session) return null;
    return session.kind === "agent" ? (
      <AgentAvatar seed={session.id} bare className="size-3.5" />
    ) : (
      <ProviderIcon provider={session.provider} className="size-3.5" />
    );
  };
  return <span className="flex size-3.5 shrink-0 items-center justify-center">{icon()}</span>;
}

/**
 * A page's pill reads its live state, so a navigation re-renders this pill and
 * nothing else in the strip. A cold page has no live state yet and falls back
 * to what its tab saved.
 */
function BrowserTabFace({ tab }: { tab: Extract<Tab, { kind: "browser" }> }) {
  const page = useBrowserPage(tab.id);
  const [broken, setBroken] = useState<string | null>(null);
  const live = page.webContentsId !== null;
  const title = live ? browserTitle(page.title, page.url) : browserTitle(tab.title, tab.url);
  const icon = page.favicon && page.favicon !== broken ? page.favicon : null;
  return (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {page.loading ? (
          <CircleNotchIcon className="size-3.5 animate-spin text-text-muted" weight="bold" />
        ) : icon ? (
          <img src={icon} alt="" className="size-3.5" onError={() => setBroken(icon)} />
        ) : (
          <GlobeIcon className="size-3.5 text-text-muted" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </>
  );
}
