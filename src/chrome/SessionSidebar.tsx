import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, CornerDownRightIcon, FolderIcon, GitBranchIcon, PlusIcon, RotateCwIcon, SearchIcon, ServerIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ActionMenu } from "./ActionMenu";
import { AgentAvatar } from "./AgentAvatar";
import {
  COPY_NAME,
  COPY_PATH,
  DELETE,
  EDIT,
  MARK_READ,
  OPEN,
  RENAME,
  SEPARATOR,
  STOP,
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
  childrenOf,
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
  /** Terminal sessions whose CLI runs, tab open or not: those offer Stop. */
  runningSessions: ReadonlyMap<string, string>;
  onStop: (session: Session) => void;
  onReorder: (ids: string[]) => void;
  /** The way to the workspace's commands, kept under the list whatever it scrolls to. */
  commands?: ReactNode;
  /** The names of the commands running in each worktree, by its path. */
  running?: ReadonlyMap<string, string[]>;
  /** Reads the worktrees and sessions again, for changes made outside this window. */
  onRefresh: () => Promise<void>;
};

type Menu =
  | { kind: "session"; point: MenuPoint; session: Session }
  | { kind: "worktree"; point: MenuPoint; tree: Worktree };

const SWITCH_HERE: MenuAction = { id: "switch", label: "Switch to Worktree", icon: "open", hotkey: "O" };
const NEW_AGENT_HERE: MenuAction = { id: "new-agent", label: "New Agent Here", icon: "agent", hotkey: "A" };
const NEW_SESSION_HERE: MenuAction = { id: "new-session", label: "New Session Here", icon: "terminal", hotkey: "S" };
const COPY_BRANCH: MenuAction = { id: "copy-branch", label: "Copy Branch", icon: "branch", hotkey: "B" };
const REMOVE_WORKTREE: MenuAction = { ...DELETE, id: "remove-worktree", label: "Remove Worktree…" };

/** A finished turn or a failure nobody has looked at. */
const unread = (session: Session) => session.status === "done" || session.status === "error";

/** What a right-click on one session offers, loudest last. `running`: its CLI is up, to stop. */
function sessionActions(session: Session, running: boolean): MenuEntry[] {
  if (session.kind === "terminal" || session.kind === "child")
    return tidy([
      OPEN,
      RENAME,
      ...(unread(session) ? [MARK_READ] : []),
      COPY_NAME,
      SEPARATOR,
      ...(running ? [STOP] : []),
      DELETE,
    ]);
  return tidy([
    OPEN,
    EDIT,
    SEPARATOR,
    { id: "notifications", label: "Notifications", icon: "bell", hotkey: "N", checked: session.notifications },
    ...(unread(session) ? [MARK_READ] : []),
    COPY_NAME,
    SEPARATOR,
    DELETE,
  ]);
}

function worktreeActions(tree: Worktree, current: boolean): MenuEntry[] {
  return tidy([
    ...(current ? [] : [SWITCH_HERE, SEPARATOR]),
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
  const [refreshing, setRefreshing] = useState(false);
  // A worktree folded or unfolded by hand; the rest follow the default: open while on screen.
  const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
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

  // The sessions each listed one started, shown under it.
  const nested = useMemo(
    () => (prefs ? childrenOf(props.sessions, prefs, query) : new Map<string, Session[]>()),
    [prefs, props.sessions, query],
  );
  const withChildren = useCallback(
    (sessions: Session[]) => sessions.flatMap((session) => [session, ...(nested.get(session.id) ?? [])]),
    [nested],
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
      return withChildren([...(mine?.agents.shown ?? []), ...(mine?.terminals.shown ?? [])]);
    },
    [listed, withChildren],
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

  // A click while one runs asks for another after it: what changed meanwhile
  // may have been read before it happened.
  const again = useRef(false);
  const refresh = () => {
    if (refreshing) {
      again.current = true;
      return;
    }
    setRefreshing(true);
    const run = (): Promise<void> =>
      props.onRefresh().then(() => {
        if (!again.current) return;
        again.current = false;
        return run();
      });
    void run().finally(() => setRefreshing(false));
  };

  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  const fold = (path: string, open: boolean) => setFolds((prev) => new Map(prev).set(path, open));

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

  // A session's row, or the field renaming it.
  const sessionRow = (session: Session, nested = false) =>
    session.id === renaming ? (
      <RenameRow
        key={session.id}
        className="h-8 px-2"
        initial={session.name}
        onCommit={(name) => {
          props.onRename(session, name);
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <Row key={session.id} {...card(session)} nested={nested} onRename={() => setRenaming(session.id)} />
    );

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
        <div className="truncate text-[11px] text-text-muted">{shortenPath(props.workspace.path)}</div>
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
            <span className="min-w-0 flex-1 truncate text-text-muted">Worktrees</span>
            <HeaderButton icon={PlusIcon} label={`New worktree ${commandKeys("new-worktree")}`} onClick={props.onNewWorktree} />
            <HeaderButton icon={RotateCwIcon} label="Refresh" spinning={refreshing} onClick={refresh} />
            <HeaderButton icon={SearchIcon} label="Find  /" onClick={() => setSearching(true)} />
            {prefs && <SidebarPrefsMenu prefs={prefs} onChange={setPrefs} />}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {prefs &&
          shown.map((tree) => {
            const index = props.worktrees.indexOf(tree);
            const isCurrent = tree.path === props.activeWorktree;
            const open = filtering || (folds.get(tree.path) ?? isCurrent);
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
              <div key={tree.path} className="mt-0.5 first:mt-0">
                <WorktreeHeader
                  tree={tree}
                  current={isCurrent}
                  open={open}
                  sessions={everyone}
                  running={props.running?.get(tree.path) ?? NONE}
                  showDiff={shows(prefs, "diff")}
                  keys={index < 9 ? commandKeys(`worktree-${index + 1}` as CommandId) : ""}
                  onFold={(next) => fold(tree.path, next)}
                  onAdd={() => props.onNewAgent(tree.path)}
                  onMenu={(point) => setMenu({ kind: "worktree", point, tree })}
                  onRemove={() => !tree.main && props.onRemoveWorktree(tree)}
                />
                {open && (
                  <div className="pb-2 pl-2">
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
                    {agents
                      .filter((agent) => nested.has(agent.id))
                      .map((agent) => (
                        <div key={agent.id} className="flex flex-col gap-0.5 pt-0.5" aria-label={`Sessions ${agent.name} started`}>
                          <div className="flex h-6 items-center gap-1.5 px-2 text-[11px] text-text-muted">
                            <AgentAvatar seed={agent.id} bare className="size-4" />
                            <span className="truncate">{agent.name}</span>
                          </div>
                          {(nested.get(agent.id) ?? []).map((child) => sessionRow(child, true))}
                        </div>
                      ))}
                    {more("agents")}
                    {terminals.length > 0 && (
                      <div className="flex flex-col gap-0.5 pt-0.5">
                        <SortableList ids={terminals.map((s) => s.id)} disabled={!draggable || mine.terminals.hidden > 0} onReorder={props.onReorder}>
                          {terminals.map((session, at) => (
                            <Fragment key={session.id}>
                              <SortableItem id={session.id} index={at} group={`terminals:${tree.path}`} disabled={!draggable || mine.terminals.hidden > 0}>
                                {sessionRow(session)}
                              </SortableItem>
                              {/* Beside the item, not in it: a drag moves the session and leaves what it started listed under it. */}
                              {(nested.get(session.id) ?? []).map((child) => sessionRow(child, true))}
                            </Fragment>
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
      {props.commands && <div className="shrink-0 border-t border-hairline px-2 py-1.5">{props.commands}</div>}

      {menu?.kind === "session" && (
        <ActionMenu
          key={menu.session.id}
          point={menu.point}
          title={selected.size > 1 && selected.has(menu.session.id) ? `${selected.size} selected` : menu.session.name}
          actions={
            selected.size > 1 && selected.has(menu.session.id)
              ? [{ ...DELETE, label: `Delete ${selected.size} Items` }]
              : sessionActions(menu.session, props.runningSessions.has(menu.session.id))
          }
          onPick={(id) => {
            const session = menu.session;
            setMenu(null);
            if (id === "rename") {
              queueMicrotask(() => setRenaming(session.id));
              return;
            }
            if (id === "open") props.onSelect(session);
            if (id === "edit") props.onEdit(session);
            if (id === "notifications") props.onToggleNotifications(session);
            if (id === "mark-read") props.onMarkRead(session);
            if (id === "copy-name") void navigator.clipboard.writeText(session.name);
            if (id === "stop") props.onStop(session);
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
          actions={worktreeActions(menu.tree, menu.tree.path === props.activeWorktree)}
          onPick={(id) => {
            const tree = menu.tree;
            setMenu(null);
            if (id === "switch") props.onSelectWorktree(tree.path);
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

function HeaderButton({
  icon: Glyph,
  label,
  spinning = false,
  onClick,
}: {
  icon: Icon;
  label: string;
  spinning?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-tauri-drag-region="false"
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <Glyph className={`size-4 ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

/**
 * A worktree's line. A click or ←/→ folds it; its plus starts an agent there;
 * opening one of its sessions, its menu or ⌥⌘1‥9 makes it the one on screen.
 * Folded, it shows who works there and how loud.
 */
function WorktreeHeader({
  tree,
  current,
  open,
  sessions,
  running,
  showDiff,
  keys,
  onFold,
  onAdd,
  onMenu,
  onRemove,
}: {
  tree: Worktree;
  current: boolean;
  open: boolean;
  sessions: Session[];
  /** Commands running here, by name: a server left up shows even with the worktree folded. */
  running: string[];
  showDiff: boolean;
  keys: string;
  onFold: (open: boolean) => void;
  onAdd: () => void;
  onMenu: (point: MenuPoint) => void;
  onRemove: () => void;
}) {
  const faces = sessions.filter((session) => session.kind === "agent").slice(0, 3);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
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
  const Glyph = tree.branch || !tree.main ? GitBranchIcon : FolderIcon;
  return (
    <div className="group/tree relative">
      <button
        type="button"
        data-nav
        data-tauri-drag-region="false"
        aria-current={current ? "true" : undefined}
        aria-expanded={open}
        title={`${tree.path}${keys ? `  ${keys} to switch` : ""}`}
        onClick={() => onFold(!open)}
        onContextMenu={(event) => onMenu(menuFromEvent(event))}
        onKeyDown={onKeyDown}
        className="flex h-8 w-full items-center gap-2 rounded-chrome pr-2 pl-8 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-border-strong"
      >
        <span className={`min-w-0 flex-1 truncate ${current ? "font-semibold text-text" : "text-text/85"}`}>
          {worktreeLabel(tree)}
        </span>
        {running.length > 0 && (
          <span
            role="img"
            aria-label={`Running: ${running.join(", ")}`}
            title={`Running: ${running.join(", ")}`}
            className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted transition-opacity group-hover/tree:opacity-0"
          >
            <ServerIcon className="size-3 text-success" />
            {running.length > 1 && <span className="tabular-nums">{running.length}</span>}
          </span>
        )}
        {!open && faces.length > 0 && (
          <span className="flex -space-x-1.5 transition-opacity group-hover/tree:opacity-0">
            {faces.map((session) => (
              <AgentAvatar key={session.id} seed={session.id} bare className="size-5" />
            ))}
          </span>
        )}
        {open && showDiff && (tree.add > 0 || tree.del > 0) && (
          <span className="shrink-0 text-[11px] tabular-nums transition-opacity group-hover/tree:opacity-0">
            <span className="text-success">+{tree.add}</span> <span className="text-danger">−{tree.del}</span>
          </span>
        )}
        {!open && (
          <span className="transition-opacity group-hover/tree:opacity-0">
            <StatusDot status={loudest(sessions)} />
          </span>
        )}
      </button>
      {/* The branch mark turns into the fold's caret under the pointer, as Linear's teams do; the row is the button. */}
      <span aria-hidden className="pointer-events-none absolute top-1 left-1.5 grid size-6 place-items-center text-icon">
        <Glyph className={`size-4 transition-opacity group-hover/tree:opacity-0 ${current ? "text-text" : ""}`} />
        <ChevronRightIcon
          className={`absolute size-3.5 opacity-0 transition-[opacity,transform] duration-150 group-hover/tree:opacity-100 ${open ? "rotate-90" : ""}`}
        />
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`New agent in ${worktreeLabel(tree)}`}
        title={`New agent in ${worktreeLabel(tree)}`}
        onClick={onAdd}
        className="absolute top-1 right-1 grid size-6 place-items-center rounded-md text-icon opacity-0 transition-opacity group-hover/tree:opacity-100 hover:bg-hover hover:text-text"
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
      aria-expanded={open}
      onClick={() => onToggle(!open)}
      className="mt-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-text-muted outline-none hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      {open ? <ChevronUpIcon aria-hidden className="size-3.5 shrink-0" /> : <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />}
      {open ? "Show less" : `${hidden} more`}
    </button>
  );
}

const NONE: string[] = [];

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
      <SearchIcon className="size-3.5 shrink-0 text-icon" />
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
        className="grid size-6 shrink-0 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
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
        <AgentAvatar seed={session.id} bare animated={session.status === "working"} className="size-10" />
        {shows(prefs, "status") && <Badge status={session.status} />}
      </span>
      {shows(prefs, "names") && (
        <span className={`w-full truncate text-center text-[12px] ${active ? "font-medium" : ""}`}>{session.name}</span>
      )}
    </button>
  );
}

const BADGE: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-warning",
  done: "bg-info",
  error: "bg-danger",
};

/**
 * Status rides the face's corner, like the unread dot on an app icon. A working
 * agent's face moves, which says it already: its spinner only shows where
 * motion is reduced and the face holds still.
 */
function Badge({ status }: { status: SessionStatus }) {
  if (status === "idle" || status === "exited") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      className={`absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-sidebar ${status === "working" ? "opacity-0 motion-reduce:opacity-100" : ""}`}
    >
      {status === "working" || status === "starting" ? (
        <StatusDot status={status} className="size-3" />
      ) : (
        <span className={`size-2.5 rounded-full ${BADGE[status]}`} />
      )}
    </span>
  );
}

/**
 * A session row: the provider it runs, its name, how long ago, its status. A
 * nested one is a session another started, listed under it.
 */
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
  nested = false,
}: CardProps & { onRename: () => void; nested?: boolean }) {
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
      title={`${session.name} — ${providerLine(session.provider, session.model)}${session.worktree ? `\n${session.worktree}` : ""}`}
      aria-current={active ? "page" : undefined}
      data-child={nested || undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome text-left transition-colors duration-150 ease-out ${nested ? "pr-2 pl-3" : "px-2"} ${SURFACE(active, selected)} ${FOCUS}`}
    >
      {nested && <CornerDownRightIcon aria-hidden className="-mr-1 size-3.5 shrink-0 text-icon" />}
      <ProviderIcon provider={session.provider} className="size-4" />
      <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{session.name}</span>
      {shows(prefs, "updated") && (
        <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{elapsed(session.updatedAt)}</span>
      )}
      {shows(prefs, "status") && <StatusDot status={session.status} />}
    </button>
  );
}
