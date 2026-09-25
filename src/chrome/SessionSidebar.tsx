import { FolderIcon, GitBranchIcon, MagnifyingGlassIcon, PlusIcon, XIcon, type Icon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ActionMenu } from "./ActionMenu";
import { AgentAvatar } from "./AgentAvatar";
import {
  CHANGE_FACE,
  COPY_NAME,
  COPY_PATH,
  DELETE,
  EDIT,
  MARK_READ,
  OPEN,
  RENAME,
  SEPARATOR,
  menuFromEvent,
  tidy,
  type MenuAction,
  type MenuEntry,
  type MenuPoint,
} from "../lib/menu";
import { ProviderIcon } from "./ProviderIcon";
import { RenameRow } from "./RenameRow";
import { SidebarPrefsMenu } from "./SidebarPrefsMenu";
import { SortableItem, SortableList } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { useNow } from "../hooks/useNow";
import { useSidebarPrefs } from "../hooks/useSidebarPrefs";
import { commandKeys, type CommandId } from "../lib/commands";
import { IS_MAC, isDeleteChord } from "../lib/hotkey";
import { providerLine } from "../lib/providers";
import {
  NO_SELECTION,
  pruneSelection,
  selectClick,
  type ClickModifiers,
  type Selection,
} from "../lib/selection";
import {
  arrangeSessions,
  canReorder,
  shows,
  trimSection,
  type Arranged,
  type SidebarPrefs,
  type Trimmed,
} from "../lib/sidebarPrefs";
import { STATUS_ORDER, statusLabel } from "../lib/status";
import { elapsed } from "../lib/time";
import type { Session, SessionStatus, Workspace, Worktree } from "../lib/types";
import { shortenPath } from "../lib/workspaces";
import { sessionPath, worktreeLabel } from "../lib/worktrees";

export type SessionSidebarProps = {
  workspace: Workspace;
  worktrees: Worktree[];
  /** Path of the worktree on screen. */
  activeWorktree: string;
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (session: Session) => void;
  onSelectWorktree: (path: string) => void;
  onNewAgent: (worktree?: string) => void;
  onNewSession: (worktree?: string) => void;
  onToggleNotifications: (session: Session) => void;
  onMarkRead: (session: Session) => void;
  onNewWorktree: () => void;
  onRemoveWorktree: (tree: Worktree) => void;
  onEdit: (session: Session) => void;
  onRename: (session: Session, name: string) => void;
  onRemove: (session: Session) => void;
  onRemoveMany: (sessions: Session[]) => void;
  onReorder: (ids: string[]) => void;
};

type Menu =
  | { kind: "session"; point: MenuPoint; session: Session }
  | { kind: "worktree"; point: MenuPoint; tree: Worktree };

const NEW_AGENT_HERE: MenuAction = { id: "new-agent", label: "New Agent Here", icon: "agent", hotkey: "A" };
const NEW_SESSION_HERE: MenuAction = { id: "new-session", label: "New Session Here", icon: "terminal", hotkey: "S" };
const COPY_BRANCH: MenuAction = { id: "copy-branch", label: "Copy Branch", icon: "branch", hotkey: "B" };
const REMOVE_WORKTREE: MenuAction = { ...DELETE, id: "remove-worktree", label: "Remove Worktree…" };

/** What a right-click on one session offers, loudest last. */
function sessionActions(session: Session): MenuEntry[] {
  if (session.kind === "terminal")
    return [OPEN, RENAME, ...(session.status === "done" ? [MARK_READ] : []), COPY_NAME, SEPARATOR, DELETE];
  return tidy([
    OPEN,
    EDIT,
    CHANGE_FACE,
    SEPARATOR,
    { id: "notifications", label: "Notifications", icon: "bell", hotkey: "N", checked: session.notifications },
    ...(session.status === "done" ? [MARK_READ] : []),
    COPY_NAME,
    SEPARATOR,
    DELETE,
  ]);
}

function worktreeActions(tree: Worktree): MenuEntry[] {
  return tidy([
    NEW_AGENT_HERE,
    NEW_SESSION_HERE,
    SEPARATOR,
    COPY_PATH,
    ...(tree.branch ? [COPY_BRANCH] : []),
    SEPARATOR,
    ...(tree.main ? [] : [REMOVE_WORKTREE]),
  ]);
}

function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickModifiers {
  return { toggle: IS_MAC ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

/** Where a keyboard-opened menu lands: under the item, as if right-clicked there. */
function pointOf(element: HTMLElement): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.bottom };
}

/**
 * The panel beside the rail: the workspace's name, then its worktrees. The one
 * on screen opens as a card holding its agents as faces and its sessions as
 * rows; the others fold to a line with who works there. Search and the view
 * menu sit on the Worktrees line.
 */
export function SessionSidebar(props: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [prefs, setPrefs] = useSidebarPrefs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  // Sections unfolded past the limit, as `agents:<path>` or `terminals:<path>`; for this run only.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const panel = useRef<HTMLDivElement>(null);
  const filtering = query.trim().length > 0;

  // Each worktree's share of the arranged sessions; a session whose worktree is gone shows under the main checkout.
  const placed = useMemo(() => {
    const out = new Map<string, Arranged>();
    for (const tree of props.worktrees) out.set(tree.path, { agents: [], terminals: [] });
    if (!prefs) return out;
    const main = props.worktrees.find((tree) => tree.main)?.path ?? props.workspace.path;
    const { agents, terminals } = arrangeSessions(props.sessions, prefs, query);
    const put = (session: Session, key: keyof Arranged) => {
      const path = sessionPath(session, props.workspace, props.worktrees);
      (out.get(path) ?? out.get(main))?.[key].push(session);
    };
    for (const session of agents) put(session, "agents");
    for (const session of terminals) put(session, "terminals");
    return out;
  }, [prefs, props.sessions, props.workspace, props.worktrees, query]);

  const shown = useMemo(
    () =>
      props.worktrees.filter((tree) => {
        const current = tree.path === props.activeWorktree;
        const mine = placed.get(tree.path);
        const count = (mine?.agents.length ?? 0) + (mine?.terminals.length ?? 0);
        if (filtering) return current || count > 0;
        if (prefs?.scope === "current") return current;
        if (prefs?.scope === "busy")
          return current || [...(mine?.agents ?? []), ...(mine?.terminals ?? [])].some((s) => s.status !== "idle");
        return true;
      }),
    [filtering, placed, prefs?.scope, props.activeWorktree, props.worktrees],
  );

  // A row ages out of the recency without anything else changing.
  const now = useNow(60_000, prefs !== null && prefs.recency !== "any");

  // What each section lists after the recency and the limit. A search looks past both.
  const listed = useMemo(() => {
    const out = new Map<string, Record<keyof Arranged, Trimmed>>();
    for (const [path, mine] of placed) {
      const trim = (key: keyof Arranged): Trimmed =>
        !prefs || filtering || expanded.has(`${key}:${path}`)
          ? { shown: mine[key], hidden: 0 }
          : trimSection(mine[key], prefs, props.activeSessionId, now);
      out.set(path, { agents: trim("agents"), terminals: trim("terminals") });
    }
    return out;
  }, [expanded, filtering, now, placed, prefs, props.activeSessionId]);

  const visible = useCallback(
    (path: string) => {
      const mine = listed.get(path);
      return [...(mine?.agents.shown ?? []), ...(mine?.terminals.shown ?? [])];
    },
    [listed],
  );

  const order = useMemo(
    () => shown.flatMap((tree) => visible(tree.path).map((session) => session.id)),
    [shown, visible],
  );

  // The open session is the one-item selection. A multi-selection is held against
  // the tab it was built on, so switching tabs elsewhere drops it and the
  // highlight never disagrees with what is on screen.
  const active = props.activeSessionId;
  const key = `${props.workspace.id}:${active ?? ""}`;
  const base = useMemo<Selection>(
    () => (active ? { ids: [active], anchor: active } : NO_SELECTION),
    [active],
  );
  const [held, setHeld] = useState<{ key: string; selection: Selection } | null>(null);
  const selection = held?.key === key ? held.selection : base;
  const setSelection = (next: Selection | ((current: Selection) => Selection)) =>
    setHeld((prev) => {
      const current = prev?.key === key ? prev.selection : base;
      return { key, selection: typeof next === "function" ? next(current) : next };
    });
  const selected = useMemo(() => new Set(pruneSelection(selection, order).ids), [selection, order]);

  const selectedSessions = () => props.sessions.filter((session) => selected.has(session.id));

  const pick = (session: Session, modifiers: ClickModifiers) => {
    if (!modifiers.toggle && !modifiers.range) {
      setHeld(null);
      props.onSelect(session);
      return;
    }
    setSelection((current) => selectClick(pruneSelection(current, order), order, session.id, modifiers));
  };

  // A row inside a multi-selection acts for the whole selection; any other row acts alone.
  const removeFrom = (session: Session) => {
    if (selected.size > 1 && selected.has(session.id)) props.onRemoveMany(selectedSessions());
    else props.onRemove(session);
  };

  const openMenu = (point: MenuPoint, session: Session) => {
    if (!selected.has(session.id)) setSelection({ ids: [session.id], anchor: session.id });
    setMenu({ kind: "session", point, session });
  };

  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  const fold = (path: string, open: boolean) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });

  // A press anywhere outside the panel puts the search away.
  useEffect(() => {
    if (!searching) return;
    const onPointerDown = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      setQuery("");
      setSearching(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [searching]);

  function onPanelKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    event.preventDefault();
    setSearching(true);
  }

  const card = (session: Session) => ({
    session,
    prefs: prefs!,
    active: session.id === props.activeSessionId,
    selected: selected.has(session.id),
    onSelect: (event: MouseEvent<HTMLButtonElement>) => pick(session, modifiersOf(event)),
    onMenu: (point: MenuPoint) => openMenu(point, session),
    onClearSelection: () => setHeld(null),
    onRemove: () => removeFrom(session),
  });

  const draggable = prefs !== null && canReorder(prefs, filtering) && renaming === null;
  const firstVisible = () => shown.flatMap((tree) => visible(tree.path))[0];

  const unfold = (key: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div ref={panel} data-sidebar-panel onKeyDown={onPanelKey} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2" title={props.workspace.path}>
        <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{props.workspace.name}</div>
        <div className="truncate text-[11px] text-kumo-subtle">{shortenPath(props.workspace.path)}</div>
      </div>

      <div className="shrink-0 px-2">
        {searching ? (
          <SearchField
            query={query}
            onChange={setQuery}
            onClose={() => {
              closeSearch();
              panel.current?.querySelector<HTMLElement>("[data-nav][aria-current]")?.focus();
            }}
            onEnter={() => {
              const first = firstVisible();
              if (first) props.onSelect(first);
            }}
            onDown={() => panel.current?.querySelector<HTMLElement>("[data-nav][data-session]")?.focus()}
          />
        ) : (
          <div className="flex h-8 items-center gap-0.5 pl-2">
            <span className="min-w-0 flex-1 truncate text-kumo-subtle">Worktrees</span>
            <HeaderButton icon={PlusIcon} label={`New worktree ${commandKeys("new-worktree")}`} onClick={props.onNewWorktree} />
            <HeaderButton icon={MagnifyingGlassIcon} label="Find  /" onClick={() => setSearching(true)} />
            {prefs && <SidebarPrefsMenu prefs={prefs} onChange={setPrefs} />}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {prefs &&
          shown.map((tree) => {
            const index = props.worktrees.indexOf(tree);
            const isCurrent = tree.path === props.activeWorktree;
            const open = isCurrent || opened.has(tree.path) || filtering;
            const mine = listed.get(tree.path) ?? { agents: { shown: [], hidden: 0 }, terminals: { shown: [], hidden: 0 } };
            const agents = mine.agents.shown;
            const terminals = mine.terminals.shown;
            const more = (key: keyof Arranged) => (
              <MoreRow
                hidden={mine[key].hidden}
                open={expanded.has(`${key}:${tree.path}`)}
                onToggle={(next) => unfold(`${key}:${tree.path}`, next)}
              />
            );
            const everyone = props.sessions.filter(
              (session) => sessionPath(session, props.workspace, props.worktrees) === tree.path,
            );
            return (
              <div key={tree.path} className={`mt-1 rounded-xl ${isCurrent ? "bg-card ring-1 ring-hairline" : ""}`}>
                <WorktreeHeader
                  tree={tree}
                  current={isCurrent}
                  open={open}
                  sessions={everyone}
                  showDiff={shows(prefs, "diff")}
                  keys={index < 9 ? commandKeys(`worktree-${index + 1}` as CommandId) : ""}
                  onSelect={() => props.onSelectWorktree(tree.path)}
                  onFold={(next) => fold(tree.path, next)}
                  onAdd={() => props.onNewAgent(tree.path)}
                  onMenu={(point) => setMenu({ kind: "worktree", point, tree })}
                  onRemove={() => !tree.main && props.onRemoveWorktree(tree)}
                />
                {open && (
                  <div className="px-1.5 pb-1.5">
                    {agents.length > 0 && (
                      <div className="grid grid-cols-3 gap-0.5">
                        <SortableList ids={agents.map((s) => s.id)} disabled={!draggable || mine.agents.hidden > 0} onReorder={props.onReorder}>
                          {agents.map((session, at) => (
                            <SortableItem key={session.id} id={session.id} index={at} group={`agents:${tree.path}`} disabled={!draggable || mine.agents.hidden > 0}>
                              <Tile {...card(session)} onEdit={() => props.onEdit(session)} />
                            </SortableItem>
                          ))}
                        </SortableList>
                      </div>
                    )}
                    {more("agents")}
                    {terminals.length > 0 && (
                      <div className="flex flex-col gap-0.5 pt-0.5">
                        <SortableList ids={terminals.map((s) => s.id)} disabled={!draggable || mine.terminals.hidden > 0} onReorder={props.onReorder}>
                          {terminals.map((session, at) => (
                            <SortableItem key={session.id} id={session.id} index={at} group={`terminals:${tree.path}`} disabled={!draggable || mine.terminals.hidden > 0}>
                              {session.id === renaming ? (
                                <RenameRow
                                  className="h-8 px-2"
                                  initial={session.name}
                                  onCommit={(name) => {
                                    props.onRename(session, name);
                                    setRenaming(null);
                                  }}
                                  onCancel={() => setRenaming(null)}
                                />
                              ) : (
                                <Row {...card(session)} onRename={() => setRenaming(session.id)} />
                              )}
                            </SortableItem>
                          ))}
                        </SortableList>
                      </div>
                    )}
                    {more("terminals")}
                    {agents.length + terminals.length + mine.agents.hidden + mine.terminals.hidden === 0 && (
                      <p className="px-2 py-1.5 text-[12px] text-placeholder">
                        {filtering
                          ? "No matches"
                          : "No sessions yet"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {menu?.kind === "session" && (
        <ActionMenu
          key={menu.session.id}
          point={menu.point}
          title={selected.size > 1 && selected.has(menu.session.id) ? `${selected.size} selected` : menu.session.name}
          actions={
            selected.size > 1 && selected.has(menu.session.id)
              ? [{ ...DELETE, label: `Delete ${selected.size} Items` }]
              : sessionActions(menu.session)
          }
          onPick={(id) => {
            const session = menu.session;
            setMenu(null);
            if (id === "rename") {
              queueMicrotask(() => setRenaming(session.id));
              return;
            }
            if (id === "open") props.onSelect(session);
            if (id === "edit" || id === "face") props.onEdit(session);
            if (id === "notifications") props.onToggleNotifications(session);
            if (id === "mark-read") props.onMarkRead(session);
            if (id === "copy-name") void navigator.clipboard.writeText(session.name);
            if (id === "delete") removeFrom(session);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === "worktree" && (
        <ActionMenu
          key={menu.tree.path}
          point={menu.point}
          title={worktreeLabel(menu.tree)}
          actions={worktreeActions(menu.tree)}
          onPick={(id) => {
            const tree = menu.tree;
            setMenu(null);
            if (id === "new-agent") props.onNewAgent(tree.path);
            if (id === "new-session") props.onNewSession(tree.path);
            if (id === "copy-path") void navigator.clipboard.writeText(tree.path);
            if (id === "copy-branch" && tree.branch) void navigator.clipboard.writeText(tree.branch);
            if (id === "remove-worktree") props.onRemoveWorktree(tree);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function HeaderButton({ icon: Glyph, label, onClick }: { icon: Icon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-tauri-drag-region="false"
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-kumo-subtle outline-none transition-colors hover:bg-hover hover:text-kumo-default focus-visible:bg-hover"
    >
      <Glyph className="size-4" />
    </button>
  );
}

/**
 * A worktree's line. Clicked, it becomes the one on screen; ←/→ fold it; its
 * plus starts an agent there. Folded, it shows who works there and how loud.
 */
function WorktreeHeader({
  tree,
  current,
  open,
  sessions,
  showDiff,
  keys,
  onSelect,
  onFold,
  onAdd,
  onMenu,
  onRemove,
}: {
  tree: Worktree;
  current: boolean;
  open: boolean;
  sessions: Session[];
  showDiff: boolean;
  keys: string;
  onSelect: () => void;
  onFold: (open: boolean) => void;
  onAdd: () => void;
  onMenu: (point: MenuPoint) => void;
  onRemove: () => void;
}) {
  const faces = sessions.filter((session) => session.kind === "agent").slice(0, 3);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !current) {
      if ((event.key === "ArrowRight") === open) return;
      event.preventDefault();
      onFold(event.key === "ArrowRight");
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      onMenu(pointOf(event.currentTarget));
    } else if (isDeleteChord(event)) {
      event.preventDefault();
      onRemove();
    }
  }
  return (
    <div className="group/tree relative">
      <button
        type="button"
        data-nav
        data-tauri-drag-region="false"
        aria-current={current ? "true" : undefined}
        aria-expanded={open}
        title={`${tree.path}${keys ? `  ${keys}` : ""}`}
        onClick={onSelect}
        onContextMenu={(event) => onMenu(menuFromEvent(event))}
        onKeyDown={onKeyDown}
        className="flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-border-strong"
      >
        {tree.branch || !tree.main ? (
          <GitBranchIcon className={`size-4 shrink-0 ${current ? "" : "text-kumo-subtle"}`} />
        ) : (
          <FolderIcon className={`size-4 shrink-0 ${current ? "" : "text-kumo-subtle"}`} />
        )}
        <span className={`min-w-0 flex-1 truncate ${current ? "font-semibold" : ""}`}>{worktreeLabel(tree)}</span>
        {!open && faces.length > 0 && (
          <span className="flex -space-x-1.5">
            {faces.map((session) => (
              <AgentAvatar key={session.id} seed={session.id} bare className="size-5" />
            ))}
          </span>
        )}
        {open && showDiff && (tree.add > 0 || tree.del > 0) && (
          <span className="shrink-0 text-[11px] tabular-nums group-hover/tree:opacity-0">
            <span className="text-kumo-success">+{tree.add}</span>{" "}
            <span className="text-kumo-danger">−{tree.del}</span>
          </span>
        )}
        {!open && <StatusDot status={loudest(sessions)} />}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`New agent in ${worktreeLabel(tree)}`}
        title={`New agent in ${worktreeLabel(tree)}`}
        onClick={onAdd}
        className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md text-kumo-subtle opacity-0 transition-opacity group-hover/tree:opacity-100 hover:bg-hover hover:text-kumo-default"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** Under a section the limit or the recency cut short: how many it left out, and a way to see them. */
function MoreRow({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: (open: boolean) => void }) {
  if (!open && hidden === 0) return null;
  return (
    <button
      type="button"
      data-nav
      data-tauri-drag-region="false"
      onClick={() => onToggle(!open)}
      className="mt-0.5 flex h-7 w-full items-center rounded-md px-2 text-left text-[12px] text-kumo-subtle outline-none hover:bg-hover hover:text-kumo-default focus-visible:bg-hover"
    >
      {open ? "Show less" : `${hidden} more`}
    </button>
  );
}

function loudest(sessions: Session[]): SessionStatus {
  for (const status of STATUS_ORDER) if (sessions.some((session) => session.status === status)) return status;
  return "idle";
}

function SearchField({
  query,
  onChange,
  onClose,
  onEnter,
  onDown,
}: {
  query: string;
  onChange: (query: string) => void;
  onClose: () => void;
  onEnter: () => void;
  onDown: () => void;
}) {
  // Mounted by the click or key that asked for it, so it takes the keyboard at once.
  const input = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  return (
    <div className="flex h-8 items-center gap-2 rounded-chrome bg-card pr-1 pl-2">
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-kumo-subtle" />
      <input
        ref={input}
        value={query}
        placeholder="Find agents and sessions"
        aria-label="Find agents and sessions"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        // Emptied and left, it has nothing to hold on to.
        onBlur={() => !query.trim() && onClose()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onEnter();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onDown();
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent py-0 outline-none"
      />
      <button
        type="button"
        aria-label="Close search"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
        className="grid size-6 shrink-0 place-items-center rounded-md text-kumo-subtle hover:bg-hover hover:text-kumo-default"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

type CardProps = {
  session: Session;
  prefs: SidebarPrefs;
  active: boolean;
  selected: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  onMenu: (point: MenuPoint) => void;
  onClearSelection: () => void;
  onRemove: () => void;
};

const SURFACE = (active: boolean, selected: boolean) =>
  active ? "bg-selected" : selected ? "bg-selected/60" : "hover:bg-hover focus-visible:bg-hover";

const FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-border-strong";

/** F2, the menu key, delete and escape: the same keys on a tile and on a row. */
function cardKeys(on: { rename?: (() => void) | undefined; menu: (point: MenuPoint) => void; clear: () => void; remove: () => void }) {
  return (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "F2" && on.rename) {
      event.preventDefault();
      on.rename();
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      on.menu(pointOf(event.currentTarget));
    } else if (event.key === "Escape") {
      on.clear();
    } else if (isDeleteChord(event)) {
      event.preventDefault();
      on.remove();
    }
  };
}

/** An agent is its face and its name; what runs it is the tab's business, not the list's. */
function Tile({ session, prefs, active, selected, onSelect, onMenu, onClearSelection, onRemove, onEdit }: CardProps & { onEdit: () => void }) {
  return (
    <button
      type="button"
      data-nav
      data-session
      data-tauri-drag-region="false"
      data-selected={selected || undefined}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(menuFromEvent(event))}
      onKeyDown={cardKeys({ rename: onEdit, menu: onMenu, clear: onClearSelection, remove: onRemove })}
      title={session.description || session.name}
      aria-current={active ? "page" : undefined}
      aria-label={session.name}
      className={`flex w-full min-w-0 flex-col items-center gap-1 rounded-xl px-1 pt-2 pb-1.5 transition-colors duration-150 ease-out ${SURFACE(active, selected)} ${FOCUS}`}
    >
      <span className="relative">
        <AgentAvatar seed={session.id} bare className="size-10" />
        {shows(prefs, "status") && <Badge status={session.status} />}
      </span>
      {shows(prefs, "names") && (
        <span className={`w-full truncate text-center text-[12px] ${active ? "font-medium" : ""}`}>{session.name}</span>
      )}
    </button>
  );
}

const BADGE: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-kumo-warning",
  done: "bg-kumo-info",
  error: "bg-kumo-danger",
};

/** Status rides the face's corner, like the unread dot on an app icon. */
function Badge({ status }: { status: SessionStatus }) {
  if (status === "idle") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-sidebar"
    >
      {status === "working" ? (
        <StatusDot status={status} className="size-3" />
      ) : (
        <span className={`size-2.5 rounded-full ${BADGE[status]}`} />
      )}
    </span>
  );
}

/** A session row: the provider it runs, its name, how long ago, its status. */
function Row({
  session,
  prefs,
  active,
  selected,
  onSelect,
  onMenu,
  onClearSelection,
  onRemove,
  onRename,
}: CardProps & { onRename: () => void }) {
  return (
    <button
      type="button"
      data-nav
      data-session
      data-tauri-drag-region="false"
      data-selected={selected || undefined}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(menuFromEvent(event))}
      onKeyDown={cardKeys({ rename: onRename, menu: onMenu, clear: onClearSelection, remove: onRemove })}
      title={`${session.name} — ${providerLine(session.provider, session.model)}`}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left transition-colors duration-150 ease-out ${SURFACE(active, selected)} ${FOCUS}`}
    >
      <ProviderIcon provider={session.provider} className="size-4" />
      <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{session.name}</span>
      {shows(prefs, "updated") && (
        <span className="shrink-0 text-[12px] text-kumo-subtle tabular-nums">{elapsed(session.updatedAt)}</span>
      )}
      {shows(prefs, "status") && <StatusDot status={session.status} />}
    </button>
  );
}
