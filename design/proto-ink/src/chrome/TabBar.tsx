import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IS_MAC, STUB_LABELS, commandKeys } from "@crew/fixtures";
import type { Tab } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";
import { useApp } from "@/lib/store";
import { fileIcon } from "@/lib/files";
import { dirtyFiles } from "@/surfaces/FileEditor";
import { Avatar, IconButton, StatusDot, Tooltip } from "@/ui";
import { DemoMenu, SourceBadge } from "./DemoMenu";
import { TabLauncher } from "./TabLauncher";
import { TRAFFIC_RESERVE } from "./Sidebar";

const STUB_ICON: Record<string, IconName> = {
  terminal: "terminal",
  browser: "globe",
  sidechat: "message",
};

/** True while the reader holds the tab-jump modifier, which swaps the trailing slot. */
function useModifierHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (IS_MAC ? event.key === "Meta" : event.key === "Control") setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (IS_MAC ? event.key === "Meta" : event.key === "Control") setHeld(false);
    };
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return held;
}

export function TabBar() {
  const { tabs, sessions, sidebarCollapsed, actions, page } = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const held = useModifierHeld();
  const dragIndex = useRef<number | null>(null);

  const measure = () => {
    const node = scroller.current;
    if (!node) return;
    setEdges({
      left: node.scrollLeft > 2,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2,
    });
  };

  useLayoutEffect(measure, [tabs.tabs.length]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keep the active pill in view when the keyboard moves it.
  useEffect(() => {
    const node = scroller.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.activeId]);

  const scrollBy = (delta: number) =>
    scroller.current?.scrollBy({ left: delta, behavior: "smooth" });

  return (
    <div
      className="relative flex h-10 shrink-0 items-center gap-1 bg-recessed pr-1"
      style={{ paddingLeft: sidebarCollapsed ? TRAFFIC_RESERVE : 6 }}
    >
      {sidebarCollapsed && (
        <Tooltip content={`Show sidebar ${commandKeys("toggle-sidebar")}`}>
          <IconButton
            icon="sidebar"
            label="Show sidebar"
            size="sm"
            className="mr-0.5"
            onClick={() => actions.toggleSidebar()}
          />
        </Tooltip>
      )}
      {edges.left && (
        <IconButton icon="chevronLeft" size="sm" label="Scroll tabs left" onClick={() => scrollBy(-240)} />
      )}
      <div
        ref={scroller}
        onScroll={measure}
        className={cx(
          "ink-scroll-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto",
          (edges.left || edges.right) && "ink-mask-x",
        )}
      >
        {tabs.tabs.map((tab, index) => (
          <TabPill
            key={tab.id}
            tab={tab}
            index={index}
            active={!page && tab.id === tabs.activeId}
            held={held}
            onDragStart={() => (dragIndex.current = index)}
            onDrop={() => {
              if (dragIndex.current !== null) actions.moveTab(dragIndex.current, index);
              dragIndex.current = null;
            }}
            sessionStatus={
              tab.kind === "session"
                ? (sessions.find((s) => s.id === tab.sessionId)?.status ?? "idle")
                : "idle"
            }
          />
        ))}
        {tabs.tabs.length === 0 && (
          <span className="px-2 text-small text-quaternary">No tabs open</span>
        )}
      </div>
      {edges.right && (
        <IconButton icon="chevronRight" size="sm" label="Scroll tabs right" onClick={() => scrollBy(240)} />
      )}
      <SourceBadge />
      <DemoMenu />
      <TabLauncher />
    </div>
  );
}

function TabPill({
  tab,
  index,
  active,
  held,
  sessionStatus,
  onDragStart,
  onDrop,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  held: boolean;
  sessionStatus: "idle" | "working" | "needs-input" | "done" | "error";
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const { sessions, actions } = useApp();
  const session = tab.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
  const title =
    tab.kind === "session"
      ? (session?.name ?? "session")
      : tab.kind === "file"
        ? (tab.relative.split("/").pop() ?? tab.relative)
        : (STUB_LABELS[tab.stub] ?? tab.title);
  const hotkey = index < 8 ? String(index + 1) : null;
  const dirty = tab.kind === "file" && dirtyFiles.get(tab.relative) === true;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      data-active={active}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          actions.requestCloseTab(tab.id);
        }
      }}
      onClick={() => actions.activateTab(tab.id)}
      className={cx(
        "group flex h-7 max-w-52 shrink-0 cursor-default select-none items-center gap-1.5 rounded-row pl-2 pr-1",
        "transition-colors duration-[var(--dur-2)]",
        active
          ? "bg-canvas text-primary e1"
          : "text-tertiary hover:bg-[var(--fill-tertiary)] hover:text-secondary",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {tab.kind === "session" ? (
          session && session.kind === "agent" ? (
            <Avatar seed={session.name} size={14} />
          ) : (
            <Icon name="terminal" size={14} className="text-icon-faint" />
          )
        ) : tab.kind === "file" ? (
          <Icon name={fileIcon(tab.relative)} size={14} className="text-icon-faint" />
        ) : (
          <Icon name={STUB_ICON[tab.stub] ?? "square"} size={14} className="text-icon-faint" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-body">{title}</span>
      {/* One fixed trailing slot holding three mutually exclusive things, stacked so
          nothing in the pill ever resizes. */}
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span
          className={cx(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-[var(--dur-1)]",
            held && hotkey ? "opacity-100" : "opacity-0",
          )}
        >
          <kbd className="rounded-xs bg-[var(--fill-tertiary)] px-1 font-sans text-micro leading-[14px] text-tertiary">
            {hotkey}
          </kbd>
        </span>
        <span
          className={cx(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-[var(--dur-1)]",
            held ? "opacity-0" : "opacity-100 group-hover:opacity-0",
          )}
        >
          {dirty ? (
            <span className="size-1.5 rounded-full bg-[var(--status-attention)]" />
          ) : (
            <StatusDot status={sessionStatus} />
          )}
        </span>
        <button
          type="button"
          aria-label={`Close ${title}`}
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation();
            actions.requestCloseTab(tab.id);
          }}
          className={cx(
            "absolute inset-0 flex items-center justify-center rounded-sm text-icon-faint",
            "opacity-0 transition-opacity duration-[var(--dur-1)] hover:bg-[var(--fill-tertiary)] hover:text-icon",
            !held && "group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <Icon name="close" size={13} />
        </button>
      </span>
    </div>
  );
}
