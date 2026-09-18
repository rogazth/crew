import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import {
  PROVIDERS,
  SETTINGS_SECTIONS,
  STATUS_ORDER,
  elapsed,
  flattenLineage,
  fuzzyMatch,
  lineage,
  providerLine,
  statusLabel,
  type Session,
} from "@crew/fixtures";
import { Avatar, CommandKbd, InputWith, Menu, ProgressRule, ProviderMark, StatusMark, TerminalMark, type MenuItem } from "@/ui";
import { store, useApp } from "@/lib/store";
import { shortModel } from "@/lib/format";
import { SidebarPrefsButton } from "./SidebarPrefs";

type Group = { key: string; label: string; sessions: Session[] };

/** Every row of the list, headers included — one uniform height, so it windows. */
export type Item =
  | { kind: "group"; group: Group; folded: boolean }
  | { kind: "row"; session: Session; index: number; depth: number };

type Listing = {
  items: Item[];
  flat: Session[];
  filtering: boolean;
};

function useGroups(): Listing {
  const state = useApp();
  const { prefs, sidebar } = state;
  return useMemo(() => {
    const query = sidebar.query.trim();
    let list = state.sessions.filter(
      (session) =>
        session.workspaceId === state.workspaceId &&
        !prefs.hiddenKinds.includes(session.kind) &&
        !(session.kind === "agent" && prefs.hiddenProviders.includes(session.provider)),
    );

    if (query) {
      list = list
        .map((session) => ({
          session,
          hit:
            fuzzyMatch(query, session.name) ??
            fuzzyMatch(query, `${session.provider} ${session.description}`),
        }))
        .filter((entry) => entry.hit !== null)
        .sort((a, b) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0))
        .map((entry) => entry.session);
    } else if (prefs.ordering === "updated") {
      list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    } else if (prefs.ordering === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }

    const groups: Group[] = [];
    const depth = new Map<string, number>();
    const put = (key: string, label: string, session: Session) => {
      const held = groups.find((g) => g.key === key);
      if (held) held.sessions.push(session);
      else groups.push({ key, label, sessions: [session] });
    };

    if (query || prefs.grouping === "none") {
      groups.push({ key: "all", label: query ? "matches" : "sessions", sessions: list });
    } else if (prefs.grouping === "kind") {
      for (const session of list) put(session.kind, session.kind === "agent" ? "agents" : "terminals", session);
      groups.sort((a, b) => (a.key === "agent" ? -1 : b.key === "agent" ? 1 : 0));
    } else if (prefs.grouping === "provider") {
      for (const session of list) {
        const key = session.kind === "terminal" ? "terminal" : session.provider;
        const label =
          session.kind === "terminal"
            ? "terminals"
            : (PROVIDERS.find((p) => p.id === session.provider)?.label ?? session.provider).toLowerCase();
        put(key, label, session);
      }
    } else if (prefs.grouping === "status") {
      for (const session of list) put(session.status, statusLabel(session.status).toLowerCase(), session);
      groups.sort((a, b) => STATUS_ORDER.indexOf(a.key as never) - STATUS_ORDER.indexOf(b.key as never));
    } else {
      // An agent that created another is its parent; the store has always known
      // this and the list has always been flat.
      const agents = list.filter((session) => session.kind === "agent");
      const nodes = flattenLineage(lineage(agents));
      for (const node of nodes) {
        depth.set(node.session.id, node.depth);
        put("lineage", "lineage", node.session);
      }
      for (const session of list) {
        if (session.kind !== "terminal") continue;
        put("terminal", "terminals", session);
      }
    }

    const collapsed = new Set(prefs.collapsedGroups);
    const flat = groups.flatMap((group) => (collapsed.has(group.key) ? [] : group.sessions));
    const headers = groups.length > 1 || prefs.grouping !== "none" || Boolean(query);
    const items: Item[] = [];
    let index = -1;
    for (const group of groups) {
      const folded = collapsed.has(group.key);
      if (headers) items.push({ kind: "group", group, folded });
      if (folded) continue;
      for (const session of group.sessions) {
        index += 1;
        items.push({ kind: "row", session, index, depth: depth.get(session.id) ?? 0 });
      }
    }
    return { items, flat, filtering: query.length > 0 };
  }, [state.sessions, state.workspaceId, prefs, sidebar.query]);
}

export function Sidebar() {
  const state = useApp();
  const { collapsed, width, view } = state.sidebar;
  const resizing = useRef(false);

  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    resizing.current = true;
    const move = (e: PointerEvent) => resizing.current && store.setSidebarWidth(e.clientX);
    const up = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (collapsed) return null;

  return (
    <div
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden bg-bg select-none"
    >
      <div
        className={clsx(
          "flex h-full w-[200%] transition-transform duration-[var(--slow)]",
          view === "settings" && "-translate-x-1/2",
        )}
        style={{ transitionTimingFunction: "var(--ease)" }}
      >
        <div className="flex w-1/2 min-w-0 flex-col">
          <SessionsView />
        </div>
        <div className="flex w-1/2 min-w-0 flex-col">
          <SettingsNav />
        </div>
      </div>
      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onDoubleClick={() => store.setSidebarWidth(268)}
        className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-accent"
      />
    </div>
  );
}

function ActionRow({
  label,
  command,
  onClick,
  active,
}: {
  label: string;
  command: Parameters<typeof CommandKbd>[0]["id"];
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex h-[var(--row-h)] shrink-0 items-center gap-2 px-2 font-mono text-sm",
        "transition-colors duration-[var(--fast)]",
        active ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
      )}
    >
      <span className="w-[14px] shrink-0 text-center text-ink-4">+</span>
      <span className="truncate">{label}</span>
      <CommandKbd id={command} className="ml-auto" />
    </button>
  );
}

function SessionsView() {
  const state = useApp();
  const { items, flat, filtering } = useGroups();
  const listRef = useRef<HTMLDivElement>(null);
  const rowH = state.density === "compact" ? 22 : 28;
  const [view, setView] = useState({ top: 0, height: 600 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const lastKey = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const dragging = useRef<string | null>(null);

  const focus = state.sidebar.focus;
  const canDrag = state.prefs.ordering === "manual" && state.prefs.grouping === "kind" && !filtering;

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const measure = () => setView({ top: node.scrollTop, height: node.clientHeight });
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  // Focus may be outside the window, so the row is scrolled into range first
  // and taken on the paint after that.
  useEffect(() => {
    if (focus < 0) return;
    const node = listRef.current;
    const at = items.findIndex((item) => item.kind === "row" && item.index === focus);
    if (node && at >= 0) {
      const top = at * rowH;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + rowH > node.scrollTop + node.clientHeight) {
        node.scrollTop = top + rowH - node.clientHeight;
      }
    }
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, items, rowH]);

  const openAt = useCallback(
    (index: number, keepSelection = false) => {
      const session = flat[index];
      if (session) store.openSession(session.id, { keepSelection });
    },
    [flat],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (renaming) return;
    const at = state.sidebar.focus;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.max(0, Math.min(flat.length - 1, (at < 0 ? -1 : at) + delta));
      store.setFocus(next);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      store.setFocus(event.key === "Home" ? 0 : flat.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openAt(at);
      return;
    }
    if (event.key === " ") {
      // Preview: open the session but keep the keyboard in the list.
      event.preventDefault();
      openAt(at, true);
      window.setTimeout(() => store.setFocus(at), 0);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      store.setSelection([]);
      store.setFocus(-1);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      const session = flat[at];
      if (session) setRenaming(session.id);
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      askDelete(flat[at]);
      return;
    }
    if (event.key === "d") {
      const now = Date.now();
      if (lastKey.current.key === "d" && now - lastKey.current.at < 600) {
        lastKey.current = { key: "", at: 0 };
        askDelete(flat[at]);
        return;
      }
      lastKey.current = { key: "d", at: now };
    }
  };

  const askDelete = (session: Session | undefined) => {
    const ids = state.selection.length > 1 ? state.selection : session ? [session.id] : [];
    if (ids.length === 0) return;
    store.confirm({
      title: ids.length > 1 ? `Delete ${ids.length} items?` : `Delete ${session?.name}?`,
      description: "The transcript goes with it. This cannot be undone.",
      action: ids.length > 1 ? `Delete ${ids.length} items` : "Delete",
      destructive: true,
      onConfirm: () => store.deleteSessions(ids),
    });
  };

  const onRowClick = (event: React.MouseEvent, session: Session, index: number) => {
    store.setFocus(index);
    if (event.metaKey || event.ctrlKey) {
      store.toggleSelection(session.id);
      return;
    }
    if (event.shiftKey) {
      const anchorId = state.selection.at(-1) ?? flat[0]?.id;
      const from = flat.findIndex((s) => s.id === anchorId);
      const to = index;
      if (from >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        store.setSelection(flat.slice(a, b + 1).map((s) => s.id));
      }
      return;
    }
    store.setSelection([session.id]);
    store.openSession(session.id, { keepSelection: true });
  };

  const contextSession = menu ? state.sessions.find((s) => s.id === menu.id) : undefined;

  // Four hundred rows is a scrollbar, not four hundred DOM nodes. Every row —
  // header or session — is exactly one `--row-h`, which is what makes the
  // arithmetic this short.
  const OVERSCAN = 8;
  const first = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  const windowed = items.slice(first, last);
  const before = first;
  const after = Math.max(0, items.length - last);

  return (
    <>
      <div className="flex shrink-0 flex-col border-b border-rule">
        <ActionRow label="New agent" command="new-agent" onClick={() => store.openOverlay({ kind: "sheet", sessionId: null })} />
        <ActionRow
          label="New session"
          command="new-session"
          onClick={() => {
            const session = store.createSession({ kind: "terminal", name: `shell ${state.sessions.length}` });
            store.openSession(session.id);
          }}
        />
        <ActionRow
          label="Routines"
          command="open-routines"
          active={state.page.kind === "routines"}
          onClick={() => store.openRoutines(null)}
        />
      </div>

      <div className="shrink-0 p-2">
        <InputWith lead={<Search size={12} strokeWidth={1.25} />} trail={<SidebarPrefsButton />}>
          <input
            value={state.sidebar.query}
            onChange={(event) => store.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && state.sidebar.query) {
                event.stopPropagation();
                store.setQuery("");
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                store.setFocus(0);
              }
            }}
            placeholder="Filter"
            aria-label="Filter sessions"
            className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-ink-4"
          />
          {state.sidebar.query ? (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => store.setQuery("")}
              className="grid size-4 place-items-center text-ink-4 hover:text-ink"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          ) : null}
        </InputWith>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label="Sessions"
        aria-multiselectable
        onKeyDown={onKeyDown}
        className="scroll min-h-0 flex-1 pb-2"
      >
        {flat.length === 0 ? (
          <p className="px-3 py-2 font-mono text-sm text-ink-4">No sessions match.</p>
        ) : null}
        <div style={{ height: before * rowH }} aria-hidden />
        {windowed.map((item) =>
          item.kind === "group" ? (
            <GroupRule
              key={`g-${item.group.key}`}
              label={item.group.label}
              count={item.group.sessions.length}
              folded={item.folded}
              onToggle={() => store.toggleGroupCollapse(item.group.key)}
              onAdd={() =>
                item.group.key === "terminal" || item.group.key === "terminals"
                  ? store.openSession(
                      store.createSession({ kind: "terminal", name: `shell ${state.sessions.length}` }).id,
                    )
                  : store.openOverlay({ kind: "sheet", sessionId: null })
              }
            />
          ) : (
            <SessionRow
              key={item.session.id}
              session={item.session}
              index={item.index}
              depth={item.depth}
              focused={focus === item.index}
              anyFocus={focus >= 0}
              renaming={renaming === item.session.id}
              onRename={(name) => {
                if (name.trim()) store.updateSession(item.session.id, { name: name.trim() });
                setRenaming(null);
                store.setFocus(item.index);
              }}
              draggable={canDrag}
              onDragStart={() => {
                dragging.current = item.session.id;
              }}
              onDrop={() => {
                if (dragging.current) store.reorderSessions(dragging.current, item.session.id);
                dragging.current = null;
              }}
              onClick={(event) => onRowClick(event, item.session, item.index)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!state.selection.includes(item.session.id)) store.setSelection([item.session.id]);
                store.setFocus(item.index);
                setMenu({ x: event.clientX, y: event.clientY, id: item.session.id });
              }}
            />
          ),
        )}
        <div style={{ height: after * rowH }} aria-hidden />
      </div>

      <div className="shrink-0 border-t border-rule">
        <ActionRow
          label="Settings"
          command="open-settings"
          active={state.page.kind === "settings"}
          onClick={() => store.openSettings("general")}
        />
      </div>

      <Menu
        open={menu !== null}
        anchor={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        label="Session actions"
        items={
          contextSession
            ? ([
                {
                  id: "edit",
                  label: contextSession.kind === "agent" ? "Edit agent" : "Rename",
                  onSelect: () =>
                    contextSession.kind === "agent"
                      ? store.openOverlay({ kind: "sheet", sessionId: contextSession.id })
                      : setRenaming(contextSession.id),
                },
                {
                  id: "duplicate",
                  label: "Open in new tab",
                  onSelect: () => store.openSession(contextSession.id),
                },
                { kind: "separator", id: "sep" },
                {
                  id: "delete",
                  label:
                    state.selection.length > 1
                      ? `Delete ${state.selection.length} items`
                      : "Delete",
                  destructive: true,
                  onSelect: () => askDelete(contextSession),
                },
              ] satisfies MenuItem[])
            : []
        }
      />
    </>
  );
}

function GroupRule({
  label,
  count,
  folded,
  onToggle,
  onAdd,
}: {
  label: string;
  count: number;
  folded: boolean;
  onToggle: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="group flex h-[var(--row-h)] items-center gap-2 px-2">
      <button type="button" onClick={onToggle} className="grouprule min-w-0 flex-1 text-left">
        <span className="shrink-0">{folded ? "▸" : "▾"}</span>
        <span className="shrink-0">{label}</span>
        <span className="shrink-0 text-ink-4">{count}</span>
      </button>
      <button
        type="button"
        aria-label={`New in ${label}`}
        onClick={onAdd}
        className="grid size-4 shrink-0 place-items-center text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink"
      >
        <Plus size={12} strokeWidth={1.25} />
      </button>
    </div>
  );
}

function SessionRow({
  session,
  index,
  depth,
  focused,
  anyFocus,
  renaming,
  onRename,
  onClick,
  onContextMenu,
  draggable,
  onDragStart,
  onDrop,
}: {
  session: Session;
  index: number;
  depth: number;
  focused: boolean;
  /** No row is focused yet, so the first one is the way into the list. */
  anyFocus: boolean;
  renaming: boolean;
  onRename: (name: string) => void;
  onClick: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  draggable: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const state = useApp();
  const selected = state.selection.includes(session.id);
  const tabs = state.tabsByWorkspace[state.workspaceId];
  const isActive = tabs?.activeId === `session:${session.id}`;
  const { show } = state.prefs;

  if (renaming) {
    return (
      <form
        className="px-2 py-[2px]"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement;
          onRename(input.value);
        }}
      >
        <input
          name="name"
          autoFocus
          defaultValue={session.name}
          onBlur={(event) => onRename(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onRename(session.name)}
          aria-label="Session name"
          className="h-[var(--row-h)] w-full rounded-[var(--r)] border border-accent bg-sunken px-1 font-mono text-sm outline-none"
        />
      </form>
    );
  }

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focused || (index === 0 && !anyFocus) ? 0 : -1}
      data-index={index}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(event) => draggable && event.preventDefault()}
      onDrop={onDrop}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={clsx(
        "relative flex h-[var(--row-h)] cursor-default items-center gap-2 px-2",
        "font-mono text-sm transition-colors duration-[var(--fast)]",
        isActive && "bg-raised",
        selected && !isActive && "bg-accent-wash",
        !isActive && !selected && "hover:bg-raised",
        session.status === "needs-input" && "border-l-2 border-l-amber pl-[6px]",
      )}
    >
      <span className="w-[14px] shrink-0 text-right text-ink-4">{index + 1}</span>
      {depth > 0 ? (
        <span
          aria-hidden
          style={{ width: depth * 10 }}
          className="shrink-0 self-stretch border-l border-rule"
        />
      ) : null}
      {show.avatar ? (
        <Avatar seed={session.name} size={14} />
      ) : session.kind === "terminal" ? (
        <TerminalMark />
      ) : (
        <ProviderMark provider={session.provider} />
      )}
      <span className={clsx("truncate", isActive ? "text-ink" : "text-ink-2")}>{session.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-ink-4">
        {show.provider && session.kind === "agent" ? (
          <span className="truncate" title={providerLine(session.provider, session.model)}>
            {shortModel(session.provider, session.model)}
          </span>
        ) : null}
        {show.updated ? <span>{elapsed(session.updatedAt)}</span> : null}
        {show.status ? <StatusMark status={session.status} /> : null}
      </span>
      <ProgressRule active={session.status === "working"} />
    </div>
  );
}

function SettingsNav() {
  const state = useApp();
  const section = state.page.kind === "settings" ? state.page.section : "general";
  return (
    <>
      <div className="flex h-[var(--row-h)] shrink-0 items-center gap-2 border-b border-rule px-2">
        <button
          type="button"
          onClick={() => {
            store.setSidebarView("sessions");
            store.closePage();
          }}
          className="flex items-center gap-1.5 font-mono text-sm text-ink-3 hover:text-ink"
        >
          <span aria-hidden>←</span>
          <span>sessions</span>
        </button>
      </div>
      <div className="scroll min-h-0 flex-1 py-1">
        {SETTINGS_SECTIONS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => store.openSettings(entry.id)}
            className={clsx(
              "flex h-[var(--row-h)] w-full items-center gap-2 px-2 font-mono text-sm",
              "transition-colors duration-[var(--fast)]",
              section === entry.id ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
            )}
          >
            <span className="w-[14px] shrink-0 text-right text-ink-4">{index + 1}</span>
            <span className="truncate">{entry.label.toLowerCase()}</span>
          </button>
        ))}
      </div>
    </>
  );
}
