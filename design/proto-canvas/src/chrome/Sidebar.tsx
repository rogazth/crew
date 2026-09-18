import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { SETTINGS_SECTIONS, commandKeys, type Session } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useRoster, waitingFor } from "@/lib/agents";
import { canReorder, groupSessions, orderSessions, visibleSessions } from "@/lib/sessionList";
import { useStore } from "@/lib/store";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { SidebarPrefsMenu } from "./SidebarPrefsMenu";
import { SidebarRow } from "./SidebarRow";
import { WorkspacePicker } from "./WorkspacePicker";

const TRAFFIC_LIGHTS = 78;

export function Sidebar() {
  const store = useStore();
  const {
    sidebarWidth,
    setSidebarWidth,
    sidebarCollapsed,
    sidebarView,
    setSidebarView,
    prefs,
    query,
    setQuery,
    wsSessions,
    statusOf,
    manualOrder,
    setManualOrder,
    collapsedGroups,
    setCollapsedGroups,
    selection,
    setSelection,
    openSession,
    activeTab,
    setPage,
    setDrawer,
    deleteSessions,
    updateSession,
    setConfirmRequest,
  } = store;

  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const ordered = useMemo(
    () => orderSessions(visibleSessions(wsSessions, prefs, query), prefs, manualOrder),
    [wsSessions, prefs, query, manualOrder],
  );
  const groups = useMemo(() => groupSessions(ordered, prefs, statusOf), [ordered, prefs, statusOf]);
  const flat = useMemo(() => groups.flatMap((group) => group.sessions), [groups]);
  const reorderable = canReorder(prefs, query);
  const roster = useRoster(store.sessions);

  /**
   * A flat item list with fixed heights, so a four-hundred-session workspace can
   * be windowed. Depth is not free: every row carries an avatar, a status ring
   * and a shadow, and at four hundred of them the browser spends longer in
   * layout than in everything else the shell does at boot.
   */
  type Item =
    | { k: "header"; id: string; label: string; count: number }
    | { k: "row"; id: string; session: Session; groupId: string };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const group of groups) {
      if (group.label) {
        out.push({ k: "header", id: `h-${group.id}`, label: group.label, count: group.sessions.length });
      }
      if (collapsedGroups.includes(group.id)) continue;
      for (const session of group.sessions) {
        out.push({ k: "row", id: session.id, session, groupId: group.id });
      }
    }
    return out;
  }, [groups, collapsedGroups]);

  const heights = useMemo(() => items.map((item) => (item.k === "header" ? 30 : 46)), [items]);
  const offsets = useMemo(() => {
    const out: number[] = [0];
    for (let i = 0; i < heights.length; i += 1) out.push(out[i]! + heights[i]!);
    return out;
  }, [heights]);
  const total = offsets.at(-1) ?? 0;

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(700);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setListHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setListHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const OVERSCAN = 6;
  let firstIndex = 0;
  let lastIndex = items.length;
  if (items.length > 60) {
    while (firstIndex < items.length && offsets[firstIndex + 1]! < scrollTop) firstIndex += 1;
    firstIndex = Math.max(0, firstIndex - OVERSCAN);
    lastIndex = firstIndex;
    while (lastIndex < items.length && offsets[lastIndex]! < scrollTop + listHeight) lastIndex += 1;
    lastIndex = Math.min(items.length, lastIndex + OVERSCAN);
  }
  const windowed = items.slice(firstIndex, lastIndex);

  const activeSessionId = activeTab?.kind === "session" ? activeTab.sessionId : null;
  const anchor = useRef<string | null>(null);

  const onOpen = useCallback(
    (session: Session) => (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        setSelection(
          selection.includes(session.id)
            ? selection.filter((id) => id !== session.id)
            : [...selection, session.id],
        );
        anchor.current = session.id;
        return;
      }
      if (event.shiftKey && anchor.current) {
        const from = flat.findIndex((s) => s.id === anchor.current);
        const to = flat.findIndex((s) => s.id === session.id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelection(flat.slice(lo, hi + 1).map((s) => s.id));
          return;
        }
      }
      anchor.current = session.id;
      setSelection([]);
      openSession(session.id);
    },
    [flat, openSession, selection, setSelection],
  );

  const requestDelete = useCallback(
    (session: Session) => {
      const many = selection.includes(session.id) && selection.length > 1;
      const ids = many ? selection : [session.id];
      setConfirmRequest({
        title: many ? `Delete ${ids.length} items?` : `Delete ${session.name}?`,
        description: many
          ? "Their transcripts and tabs go with them. This cannot be undone."
          : "Its transcript and any open tab go with it. This cannot be undone.",
        actionLabel: many ? `Delete ${ids.length} items` : "Delete",
        destructive: true,
        onConfirm: () => deleteSessions(ids),
      });
    },
    [deleteSessions, selection, setConfirmRequest],
  );

  const commitDrag = useCallback(() => {
    if (!dragFrom || !dragOver || dragFrom === dragOver) {
      setDragFrom(null);
      setDragOver(null);
      return;
    }
    const next = manualOrder.slice();
    const from = next.indexOf(dragFrom);
    const to = next.indexOf(dragOver);
    if (from >= 0 && to >= 0) {
      next.splice(from, 1);
      next.splice(to, 0, dragFrom);
      setManualOrder(next);
    }
    setDragFrom(null);
    setDragOver(null);
  }, [dragFrom, dragOver, manualOrder, setManualOrder]);

  const startResize = (event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (move: globalThis.MouseEvent) => setSidebarWidth(startWidth + move.clientX - startX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (sidebarCollapsed) return null;

  return (
    <aside
      className="relative z-20 flex h-full shrink-0 flex-col bg-sunken"
      style={{ width: sidebarWidth }}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 pr-2" style={{ paddingLeft: TRAFFIC_LIGHTS }}>
        <WorkspacePicker />
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="absolute inset-0 flex flex-col transition-transform duration-[220ms]"
          style={{
            transform: sidebarView === "settings" ? "translateX(-14%)" : "none",
            opacity: sidebarView === "settings" ? 0 : 1,
            transitionTimingFunction: "var(--ease-out)",
          }}
          aria-hidden={sidebarView === "settings"}
        >
          <div className="flex flex-col gap-0.5 px-2 pb-1.5">
            <ActionRow icon="plus" label="New agent" keys={commandKeys("new-agent")} onClick={() => setDrawer({ kind: "agent-sheet", mode: "create" })} />
            <ActionRow icon="squareTerminal" label="New session" keys={commandKeys("new-session")} onClick={() => store.openStub("terminal", "Terminal")} />
            <ActionRow icon="repeat" label="Routines" keys={commandKeys("open-routines")} onClick={() => setPage({ kind: "routines" })} />
          </div>

          <div className="px-2 pb-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              className="h-8"
              leading={<Icon name="search" size={14} className="shrink-0 text-ink-38" />}
              trailing={<SidebarPrefsMenu />}
            />
          </div>

          <div
            ref={listRef}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            className="scroller min-h-0 flex-1 px-2 pb-3"
          >
            {items.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-ink-38">
                {query ? `Nothing matches “${query}”.` : "No sessions in this workspace yet."}
              </p>
            )}
            <div className="relative" style={{ height: total }}>
              {windowed.map((item, at) => {
                const index = firstIndex + at;
                const top = offsets[index] ?? 0;
                if (item.k === "header") {
                  const folded = collapsedGroups.includes(item.id.slice(2));
                  const groupId = item.id.slice(2);
                  return (
                    <div
                      key={item.id}
                      className="group/head absolute inset-x-0 flex h-7 items-center gap-1 px-1"
                      style={{ transform: `translateY(${top}px)` }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedGroups(
                            folded
                              ? collapsedGroups.filter((id) => id !== groupId)
                              : [...collapsedGroups, groupId],
                          )
                        }
                        className="flex items-center gap-1 rounded-chip px-1 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38 hover:text-ink-70"
                      >
                        <Icon name={folded ? "chevronRight" : "chevronDown"} size={12} />
                        {item.label}
                        <span className="tabular-nums opacity-70">{item.count}</span>
                      </button>
                      <span className="flex-1" />
                      <button
                        type="button"
                        aria-label={`New in ${item.label}`}
                        onClick={() =>
                          groupId === "terminal"
                            ? store.openStub("terminal", "Terminal")
                            : setDrawer({ kind: "agent-sheet", mode: "create" })
                        }
                        className="grid size-5 place-items-center rounded-chip text-ink-38 opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover/head:opacity-100"
                      >
                        <Icon name="plus" size={13} />
                      </button>
                    </div>
                  );
                }
                const session = item.session;
                return (
                  <div
                    key={session.id}
                    className={cx(
                      "absolute inset-x-0",
                      dragOver === session.id && dragFrom && "rounded-control ring-2 ring-[var(--accent-line)]",
                    )}
                    style={{ transform: `translateY(${top}px)` }}
                  >
                    <SidebarRow
                      session={session}
                      status={statusOf(session.id)}
                      waiting={waitingFor(roster, session.id).length}
                      active={activeSessionId === session.id}
                      selected={selection.includes(session.id)}
                      renaming={renaming === session.id}
                      draggable={reorderable}
                      onOpen={onOpen(session)}
                      onStartRename={() => setRenaming(session.id)}
                      onCancelRename={() => setRenaming(null)}
                      onRename={(name) => {
                        if (name.trim()) updateSession(session.id, { name: name.trim() });
                        setRenaming(null);
                      }}
                      onEdit={() => setDrawer({ kind: "agent-sheet", mode: "edit", sessionId: session.id })}
                      onDelete={() => requestDelete(session)}
                      onDragStart={() => setDragFrom(session.id)}
                      onDragOver={() => setDragOver(session.id)}
                      onDrop={commitDrag}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div
          className="absolute inset-0 flex flex-col bg-sunken transition-transform duration-[220ms]"
          style={{
            transform: sidebarView === "settings" ? "none" : "translateX(100%)",
            transitionTimingFunction: "var(--ease-out)",
          }}
          aria-hidden={sidebarView !== "settings"}
        >
          <SettingsSidebar />
        </div>
      </div>

      <footer className="shrink-0 border-t border-[var(--line-soft)] p-2">
        <ActionRow
          icon="settings"
          label="Settings"
          keys={commandKeys("open-settings")}
          onClick={() => {
            setSidebarView("settings");
            setPage({ kind: "settings", section: "general" });
          }}
        />
      </footer>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startResize}
        onDoubleClick={() => setSidebarWidth(264)}
        className="absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-[var(--line)] hover:after:bg-[var(--accent-line)]"
      />
    </aside>
  );
}

function SettingsSidebar() {
  const { page, setPage, setSidebarView } = useStore();
  const section = page?.kind === "settings" ? page.section : "general";
  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={() => {
            setSidebarView("sessions");
            setPage(null);
          }}
          className="rise-1 flex h-8 flex-1 items-center gap-2 rounded-control px-2 text-base font-medium text-ink hover:bg-raised hover:el-1"
        >
          <Icon name="arrowLeft" size={15} />
          Settings
        </button>
      </div>
      <nav className="scroller flex min-h-0 flex-1 flex-col gap-0.5 px-2">
        {SETTINGS_SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setPage({ kind: "settings", section: entry.id })}
            className={cx(
              "rise-1 flex h-9 items-center gap-2.5 rounded-control px-2.5 text-base",
              entry.id === section ? "bg-raised text-ink el-1" : "text-ink-70 hover:bg-raised hover:text-ink",
            )}
          >
            <Icon name={SECTION_ICON[entry.id] ?? "settings"} size={15} className="opacity-70" />
            {entry.label}
          </button>
        ))}
      </nav>
    </>
  );
}

const SECTION_ICON: Record<string, GlyphName> = {
  general: "settings",
  appearance: "palette",
  terminal: "terminal",
  providers: "server",
  keybindings: "keyboard",
  about: "info",
};

function ActionRow({
  icon,
  label,
  keys,
  onClick,
}: {
  icon: GlyphName;
  label: string;
  keys?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rise-1 group flex h-8 items-center gap-2.5 rounded-control px-2 text-base text-ink-70 hover:bg-raised hover:text-ink hover:el-1"
    >
      <Icon name={icon} size={15} className="shrink-0 opacity-70" />
      <span className="flex-1 text-left">{label}</span>
      {keys && <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">{keys}</Kbd>}
    </button>
  );
}
