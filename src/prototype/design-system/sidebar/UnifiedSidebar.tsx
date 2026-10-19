// PROTOTYPE — throwaway. The sidebar the proposals converged on, forked from
// the real SessionSidebar so it keeps its search, view menu, selection, drag,
// keys and menus:
//
//   header    the workspace's name, renamed in place; its commands as a pill
//             beside it, since they belong to the workspace; its menu, with the path
//   bots      as they are today: faces in a grid, status on the corner; the
//             sessions' view menu never touches them
//   sessions  grouped as the view menu says, and each line says only what its
//             group does not: no grouping or by status, two lines with the
//             worktree under the name; by worktree, or with the worktree
//             hidden, one line
//
// No worktree is "current": a session belongs to one and says so.
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EllipsisIcon,
  PencilIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  LayersIcon,
  XIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ActionMenu } from "../../../chrome/ActionMenu";
import { BotAvatar } from "../../../chrome/BotAvatar";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { RenameRow } from "../../../chrome/RenameRow";
import type { SessionSidebarProps } from "../../../chrome/SessionSidebar";
import { SortableItem, SortableList } from "../../../chrome/SortableList";
import { StatusDot } from "../../../chrome/StatusDot";
import { useNow } from "../../../hooks/useNow";
import { useSidebarPrefs } from "../../../hooks/useSidebarPrefs";
import { commandKeys } from "../../../lib/commands";
import { IS_MAC, isDeleteChord } from "../../../lib/hotkey";
import { childrenOf, failedUnseen, unseen } from "../../../lib/letters";
import {
  COPY_NAME,
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
} from "../../../lib/menu";
import { providerLine } from "../../../lib/providers";
import { NO_SELECTION, pruneSelection, selectClick, type ClickModifiers, type Selection } from "../../../lib/selection";
import { arrangeSessions, canReorder, shows, trimSection, type SidebarPrefs, type Trimmed } from "../../../lib/sidebarPrefs";
import { statusLabel } from "../../../lib/status";
import { elapsed } from "../../../lib/time";
import type { Session, SessionStatus, Worktree } from "../../../lib/types";
import { sessionPath, worktreeLabel } from "../../../lib/worktrees";
import { useWorkspaceRenameRequest } from "./renameBus";
import { DEFAULT_GROUPING, UnifiedPrefsMenu, type Grouping } from "./UnifiedPrefsMenu";

// ── The view's own choices, kept in this browser only ───────────────────────

function useStored<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Kept for this page only.
      }
    },
    [key],
  );
  return [value, set];
}

// ── Reading a session's state ───────────────────────────────────────────────

const running = (s: Session) => s.status === "working" || s.status === "starting" || s.status === "background";
/** What waits on you: a question, a failure, a pause. */
const urgent = (s: Session) => Boolean(s.paused) || s.status === "needs-input" || s.status === "error" || failedUnseen(s);
/** Finished, and you have not looked. */
const unread = (s: Session, activeId: string | null) => s.id !== activeId && unseen(s) && (s.status === "done" || s.status === "idle");

/** The one dot a line shows: its status, with pauses, failures and unread news folded in. */
function dotOf(s: Session, activeId: string | null): SessionStatus {
  if (s.paused) return "needs-input";
  if (failedUnseen(s)) return "error";
  if (unread(s, activeId)) return "done";
  return s.status;
}

const STATUS_GROUPS = [
  { id: "needs", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "unread", label: "Unread" },
  { id: "idle", label: "Idle" },
] as const;

function bucketOf(s: Session, activeId: string | null): (typeof STATUS_GROUPS)[number]["id"] {
  if (urgent(s)) return "needs";
  if (running(s)) return "running";
  if (unread(s, activeId)) return "unread";
  return "idle";
}

/** A worktree's mark, as the shipped sidebar draws it: a branch, or a folder for a main checkout with none. */
function TreeGlyph({ tree, className }: { tree: Worktree | undefined; className: string }) {
  return !tree || tree.branch || !tree.main ? <GitBranchIcon aria-hidden className={className} /> : <FolderIcon aria-hidden className={className} />;
}

// ── Menus ───────────────────────────────────────────────────────────────────

const NEW_SESSION_HERE: MenuAction = { id: "new-session", label: "New Session Here", icon: "terminal", hotkey: "S" };
const COPY_BRANCH: MenuAction = { id: "copy-branch", label: "Copy Branch", icon: "branch", hotkey: "B" };
const REMOVE_WORKTREE: MenuAction = { ...DELETE, id: "remove-worktree", label: "Remove Worktree…" };
const NEW_WORKTREE: MenuAction = { id: "new-worktree", label: "New Worktree…", icon: "branch", hotkey: "W" };
const REMOVE_WORKSPACE: MenuAction = { ...DELETE, label: "Remove Workspace…" };

function sessionActions(session: Session, tree: Worktree | undefined): MenuEntry[] {
  const unreadNow = session.status === "done" || session.status === "error" || unseen(session);
  if (session.kind === "bot")
    return tidy([
      OPEN,
      EDIT,
      SEPARATOR,
      { id: "notifications", label: "Notifications", icon: "bell", hotkey: "N", checked: session.notifications },
      ...(unreadNow ? [MARK_READ] : []),
      COPY_NAME,
      SEPARATOR,
      DELETE,
    ]);
  return tidy([
    OPEN,
    RENAME,
    ...(unreadNow ? [MARK_READ] : []),
    COPY_NAME,
    SEPARATOR,
    { ...NEW_SESSION_HERE, label: tree ? `New Session in ${worktreeLabel(tree)}` : NEW_SESSION_HERE.label },
    ...(tree?.branch ? [COPY_BRANCH] : []),
    SEPARATOR,
    DELETE,
  ]);
}

function worktreeActions(tree: Worktree): MenuEntry[] {
  return tidy([NEW_SESSION_HERE, SEPARATOR, ...(tree.branch ? [COPY_BRANCH] : []), SEPARATOR, ...(tree.main ? [] : [REMOVE_WORKTREE])]);
}

type Menu =
  | { kind: "session"; point: MenuPoint; session: Session }
  | { kind: "worktree"; point: MenuPoint; tree: Worktree }
  | { kind: "workspace"; point: MenuPoint };

function pointOf(element: HTMLElement): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.bottom };
}

function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickModifiers {
  return { toggle: IS_MAC ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

// ── The panel ───────────────────────────────────────────────────────────────

type Section = { key: string; label?: string; tree?: Worktree; sessions: Session[] };

export function UnifiedSidebar(props: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [prefs, setPrefs] = useSidebarPrefs();
  const [grouping, setGrouping] = useStored<Grouping>("crew-proto-grouping", DEFAULT_GROUPING);
  const [hiddenTrees, setHiddenTrees] = useStored<string[]>("crew-proto-hidden-trees", []);
  const [showTree, setShowTree] = useStored<boolean>("crew-proto-show-worktree", true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const panel = useRef<HTMLDivElement>(null);
  const filtering = query.trim().length > 0;
  const activeId = props.activeSessionId;
  const main = props.worktrees.find((tree) => tree.main)?.path ?? props.workspace.path;
  const pathOf = useCallback((s: Session) => sessionPath(s, props.workspace, props.worktrees), [props.workspace, props.worktrees]);
  const treeOf = (s: Session) => props.worktrees.find((t) => t.path === pathOf(s));

  // "Rename" on the rail's mark lands here, on the name it renames.
  const request = useWorkspaceRenameRequest();
  if (request.wanted === props.workspace.id) {
    request.clear();
    setNaming(true);
  }

  // The view menu is the sessions': bots keep their own order and every filter passes them by.
  const arranged = useMemo(() => (prefs ? arrangeSessions(props.sessions, { ...prefs, hiddenKinds: [] }, query) : null), [prefs, props.sessions, query]);
  const bots = useMemo(
    () => (prefs ? arrangeSessions(props.sessions, { ...prefs, ordering: "manual", hiddenKinds: [], hiddenProviders: [] }, query).bots : []),
    [prefs, props.sessions, query],
  );
  const terminals = useMemo(
    () => (arranged?.terminals ?? []).filter((s) => props.home || !hiddenTrees.includes(pathOf(s))),
    [arranged, hiddenTrees, pathOf, props.home],
  );

  const failing = useMemo(() => {
    const out = new Set<string>();
    for (const [parent, children] of childrenOf(props.sessions)) if (children.some(failedUnseen)) out.add(parent);
    return out;
  }, [props.sessions]);

  const now = useNow(60_000, prefs !== null && prefs.recency !== "any");
  const trim = useCallback(
    (sessions: Session[], key: string): Trimmed =>
      !prefs || filtering || expanded.has(key) ? { shown: sessions, hidden: 0 } : trimSection(sessions, prefs, activeId, now),
    [activeId, expanded, filtering, now, prefs],
  );

  const mode: Grouping = props.home ? "none" : grouping;
  const sections = useMemo<Section[]>(() => {
    if (mode === "worktree")
      return props.worktrees
        .filter((tree) => !hiddenTrees.includes(tree.path))
        .map((tree) => ({ key: `tree:${tree.path}`, tree, sessions: terminals.filter((s) => pathOf(s) === tree.path) }))
        .filter((section) => !filtering || section.sessions.length > 0);
    if (mode === "status")
      return STATUS_GROUPS.map((group) => ({
        key: `status:${group.id}`,
        label: group.label,
        sessions: terminals.filter((s) => bucketOf(s, activeId) === group.id),
      })).filter((section) => section.sessions.length > 0);
    return [{ key: "sessions", sessions: terminals }];
  }, [activeId, filtering, hiddenTrees, mode, pathOf, props.worktrees, terminals]);

  const open = (section: Section) => filtering || (folds.get(section.key) ?? true);
  const listed = useMemo(() => new Map(sections.map((section) => [section.key, trim(section.sessions, section.key)])), [sections, trim]);
  const visible = (section: Section) => (open(section) ? (listed.get(section.key)?.shown ?? []) : []);

  const order = [...bots, ...sections.flatMap(visible)].map((s) => s.id);

  // The open session is the one-item selection; a multi-selection is held against the tab it was built on.
  const key = `${props.workspace.id}:${activeId ?? ""}`;
  const base = useMemo<Selection>(() => (activeId ? { ids: [activeId], anchor: activeId } : NO_SELECTION), [activeId]);
  const [held, setHeld] = useState<{ key: string; selection: Selection } | null>(null);
  const selection = held?.key === key ? held.selection : base;
  const setSelection = (next: Selection | ((current: Selection) => Selection)) =>
    setHeld((prev) => {
      const current = prev?.key === key ? prev.selection : base;
      return { key, selection: typeof next === "function" ? next(current) : next };
    });
  const selected = new Set(pruneSelection(selection, order).ids);

  const pick = (session: Session, modifiers: ClickModifiers) => {
    if (!modifiers.toggle && !modifiers.range) {
      setHeld(null);
      props.onSelect(session);
      return;
    }
    setSelection((current) => selectClick(pruneSelection(current, order), order, session.id, modifiers));
  };

  const removeFrom = (session: Session) => {
    if (selected.size > 1 && selected.has(session.id)) props.onRemoveMany(props.sessions.filter((s) => selected.has(s.id)));
    else props.onRemove(session);
  };

  const openMenu = (point: MenuPoint, session: Session) => {
    if (!selected.has(session.id)) setSelection({ ids: [session.id], anchor: session.id });
    setMenu({ kind: "session", point, session });
  };

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

  const card = (session: Session): CardProps => ({
    session,
    prefs: prefs!,
    active: session.id === activeId,
    selected: selected.has(session.id),
    dot: dotOf(session, activeId),
    onSelect: (event) => pick(session, modifiersOf(event)),
    onMenu: (point) => openMenu(point, session),
    onClearSelection: () => setHeld(null),
    onRemove: () => removeFrom(session),
  });

  const rename = (session: Session) => ({
    initial: session.name,
    onCommit: (name: string) => {
      props.onRename(session, name);
      setRenaming(null);
    },
    onCancel: () => setRenaming(null),
  });

  const sessionRow = (session: Session) => {
    const editing = session.id === renaming ? rename(session) : null;
    if (mode === "worktree" || !showTree)
      return editing ? (
        <RenameRow key={session.id} className="h-8 px-1" {...editing} />
      ) : (
        <Line key={session.id} {...card(session)} onRename={() => setRenaming(session.id)} />
      );
    const tree = treeOf(session);
    return (
      <TwoLines
        key={session.id}
        {...card(session)}
        place={{ label: tree ? worktreeLabel(tree) : "main", tree }}
        editing={editing}
        onRename={() => setRenaming(session.id)}
      />
    );
  };

  const draggable = prefs !== null && canReorder(prefs, filtering) && renaming === null && mode !== "status";
  const botsDraggable = !filtering && renaming === null;
  const unfold = (key: string, next: boolean) =>
    setExpanded((prev) => {
      const out = new Set(prev);
      if (next) out.add(key);
      else out.delete(key);
      return out;
    });
  const fold = (key: string, next: boolean) => setFolds((prev) => new Map(prev).set(key, next));
  const empty = terminals.length === 0;

  return (
    <div ref={panel} data-sidebar-panel onKeyDown={onPanelKey} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <WorkspaceHeader
          name={props.home ? "Home" : props.workspace.name}
          path={props.workspace.path}
          editable={!props.home && Boolean(props.proto)}
          naming={naming}
          onNaming={setNaming}
          onRename={(name) => props.proto?.onRenameWorkspace(name)}
          onMenu={(point) => setMenu({ kind: "workspace", point })}
          commands={
            !props.home && props.proto ? <CommandsPill {...props.proto.commands} running={props.running} worktrees={props.worktrees} /> : null
          }
        />

        {props.home && <div className="px-2 pb-1">{props.home.actions}</div>}

        {/* Bots, as they are today. */}
        {prefs && !(filtering && bots.length === 0) && (
          <div className="px-2 pb-1">
            <div className={`${STICKY} flex h-8 items-center gap-0.5 pl-2`}>
              <span className="min-w-0 flex-1 truncate text-text-muted">Bots</span>
              <HeaderButton icon={PlusIcon} label={`New bot ${commandKeys("new-bot")}`} onClick={() => props.onNewBot(main)} />
            </div>
            {bots.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-0.5">
                <SortableList ids={bots.map((s) => s.id)} disabled={!botsDraggable} onReorder={props.onReorder}>
                  {bots.map((session, at) => (
                    <SortableItem key={session.id} id={session.id} index={at} group="bots" disabled={!botsDraggable}>
                      <Tile {...card(session)} failed={failing.has(session.id)} onEdit={() => props.onEdit(session)} />
                    </SortableItem>
                  ))}
                </SortableList>
              </div>
            ) : (
              !filtering && (
                <button
                  type="button"
                  data-nav
                  onClick={() => props.onNewBot(main)}
                  className="flex w-full items-center gap-2.5 rounded-chrome px-2 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-icon">
                    <PlusIcon aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">New bot</span>
                </button>
              )
            )}
          </div>
        )}

        {/* Sessions: search, refresh, the view menu and a new one, then the groups. */}
        <div className="px-2">
          <div className={`${STICKY} -mx-2 px-2`}>
            {searching ? (
              <SearchField
                query={query}
                onChange={setQuery}
                onClose={() => {
                  closeSearch();
                  panel.current?.querySelector<HTMLElement>("[data-nav][aria-current]")?.focus();
                }}
                onEnter={() => {
                  const first = [...bots, ...sections.flatMap(visible)][0];
                  if (first) props.onSelect(first);
                }}
                onDown={() => panel.current?.querySelector<HTMLElement>("[data-nav][data-session]")?.focus()}
              />
            ) : (
              <div className="flex h-8 items-center gap-0.5 pl-2">
                <span className="min-w-0 flex-1 truncate text-text-muted">Sessions</span>
                <HeaderButton icon={RotateCwIcon} label="Refresh" spinning={refreshing} onClick={refresh} />
                <HeaderButton icon={SearchIcon} label="Find  /" onClick={() => setSearching(true)} />
                {prefs && (
                  <UnifiedPrefsMenu
                    prefs={prefs}
                    onChange={setPrefs}
                    grouping={mode}
                    onGrouping={setGrouping}
                    worktrees={props.home ? [] : props.worktrees}
                    hiddenTrees={hiddenTrees}
                    onHiddenTrees={setHiddenTrees}
                    showWorktree={showTree}
                    onShowWorktree={setShowTree}
                  />
                )}
                <HeaderButton icon={PlusIcon} label={`New session ${commandKeys("new-session")}`} onClick={() => props.onNewSession()} />
              </div>
            )}
          </div>

          {prefs &&
            sections.map((section) => {
              const mine = listed.get(section.key) ?? { shown: [], hidden: 0 };
              const isOpen = open(section);
              return (
                <div key={section.key} className="pb-1">
                  {section.tree ? (
                    <WorktreeHeading
                      tree={section.tree}
                      open={isOpen}
                      count={section.sessions.length}
                      loudest={loudest(section.sessions, activeId)}
                      showDiff={shows(prefs, "diff")}
                      running={props.running?.get(section.tree.path)?.length ?? 0}
                      onFold={(next) => fold(section.key, next)}
                      onAdd={() => props.onNewSession(section.tree!.path)}
                      onMenu={(point) => setMenu({ kind: "worktree", point, tree: section.tree! })}
                    />
                  ) : (
                    section.label && (
                      <button
                        type="button"
                        onClick={() => fold(section.key, !isOpen)}
                        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-text-muted hover:text-text"
                      >
                        <ChevronRightIcon className={`size-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        <span className="min-w-0 flex-1 truncate">{section.label}</span>
                        <span className="tabular-nums">{section.sessions.length}</span>
                      </button>
                    )
                  )}
                  {isOpen && (
                    // Under a worktree, its sessions start where its name does (8px pad + 16px icon + 8px
                    // gap = 32px: pl-6 plus a line's own px-2). No line hangs from the icon: the indent says it.
                    <div className={section.tree ? "pl-6" : ""}>
                      {mine.shown.length > 0 && (
                        <div className="flex flex-col gap-0.5">
                          <SortableList ids={mine.shown.map((s) => s.id)} disabled={!draggable || mine.hidden > 0} onReorder={props.onReorder}>
                            {mine.shown.map((session, at) => (
                              <SortableItem key={session.id} id={session.id} index={at} group={section.key} disabled={!draggable || mine.hidden > 0}>
                                {sessionRow(session)}
                              </SortableItem>
                            ))}
                          </SortableList>
                        </div>
                      )}
                      <MoreRow hidden={mine.hidden} open={expanded.has(section.key)} onToggle={(next) => unfold(section.key, next)} />
                      {section.tree && mine.shown.length + mine.hidden === 0 && (
                        <NewSessionRow onClick={() => props.onNewSession(section.tree!.path)} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          {prefs && empty && mode !== "worktree" &&
            (filtering ? (
              <p className="px-2 py-1.5 text-[12px] text-placeholder">No matches</p>
            ) : (
              <NewSessionRow onClick={() => props.onNewSession()} />
            ))}
        </div>
      </div>

      {props.home?.foot}

      {menu?.kind === "session" && (
        <ActionMenu
          key={menu.session.id}
          point={menu.point}
          title={selected.size > 1 && selected.has(menu.session.id) ? `${selected.size} selected` : menu.session.name}
          actions={
            selected.size > 1 && selected.has(menu.session.id)
              ? [{ ...DELETE, label: `Delete ${selected.size} Items` }]
              : sessionActions(menu.session, props.home ? undefined : treeOf(menu.session))
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
            if (id === "new-session") props.onNewSession(pathOf(session));
            if (id === "copy-branch") void navigator.clipboard.writeText(treeOf(session)?.branch ?? "");
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
          path={menu.tree.path}
          actions={worktreeActions(menu.tree)}
          onPick={(id) => {
            const tree = menu.tree;
            setMenu(null);
            if (id === "new-session") props.onNewSession(tree.path);
            if (id === "copy-branch" && tree.branch) void navigator.clipboard.writeText(tree.branch);
            if (id === "remove-worktree") props.onRemoveWorktree(tree);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === "workspace" && (
        <ActionMenu
          point={menu.point}
          title={props.workspace.name}
          path={props.workspace.path}
          actions={[RENAME, NEW_WORKTREE, SEPARATOR, REMOVE_WORKSPACE]}
          onPick={(id) => {
            setMenu(null);
            if (id === "rename") queueMicrotask(() => setNaming(true));
            if (id === "new-worktree") props.onNewWorktree();
            if (id === "delete") props.proto?.onRemoveWorkspace();
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ── The header ──────────────────────────────────────────────────────────────

/**
 * The workspace's name, in its own type, renamed where it stands: a click on
 * it, on the pencil that shows beside it on hover, or ⋯ › Rename turns the name itself into the field. Its commands and the
 * menu sit beside it; the menu holds the path and copies it.
 */
function WorkspaceHeader({
  name,
  path,
  editable,
  naming,
  onNaming,
  onRename,
  onMenu,
  commands,
}: {
  name: string;
  path: string;
  editable: boolean;
  naming: boolean;
  onNaming: (naming: boolean) => void;
  onRename: (name: string) => void;
  onMenu: (point: MenuPoint) => void;
  commands: ReactNode;
}) {
  return (
    <div className="flex h-12 items-center gap-1 pr-2 pl-3">
      {naming ? (
        <NameField
          initial={name}
          onDone={(next) => {
            onNaming(false);
            if (next && next !== name) onRename(next);
          }}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center">
          {/* One target: the name and the pencil beside it rename alike. */}
          <button
            type="button"
            title={editable ? `${path}\nClick to rename` : path}
            onClick={() => editable && onNaming(true)}
            onContextMenu={(event) => editable && onMenu(menuFromEvent(event))}
            className={`group/title flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-border-strong ${editable ? "cursor-text" : "cursor-default"}`}
          >
            <span className={`${NAME_TYPE} min-w-0 truncate`}>{name}</span>
            {editable && (
              <PencilIcon aria-hidden className="size-3 shrink-0 text-icon opacity-0 transition-opacity group-hover/title:opacity-100" />
            )}
          </button>
        </div>
      )}
      {commands}
      {editable && (
        <HeaderButton icon={EllipsisIcon} label="Workspace" onClick={(event) => onMenu(pointOf(event.currentTarget))} />
      )}
    </div>
  );
}

/** The name's type, shared by the title and its field so renaming changes nothing but the caret. */
const NAME_TYPE = "text-[15px] leading-6 font-semibold tracking-[-0.01em] text-text";

function NameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit ? value.trim() : null);
  };
  return (
    <input
      ref={(node) => {
        if (node && !done.current && document.activeElement !== node) {
          node.focus({ preventScroll: true });
          node.select();
        }
      }}
      value={value}
      aria-label="Workspace name"
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      }}
      // The title itself, editable: the same type in the same place, nothing behind it but the caret.
      className={`${NAME_TYPE} h-6 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 outline-none`}
    />
  );
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * The workspace's commands, beside its name: they belong to the workspace, as
 * its name does. A quiet button like the ⋯ beside it, its glyph and, while any
 * run, how many; a dot when one waits on your review. The names run in its title.
 */
function CommandsPill({
  live,
  asking,
  open,
  onToggle,
  running,
  worktrees,
}: {
  live: number;
  asking: number;
  orphans: number;
  open: boolean;
  onToggle: () => void;
  running?: ReadonlyMap<string, string[]> | undefined;
  worktrees: Worktree[];
}) {
  const names = [...(running ?? new Map<string, string[]>())].flatMap(([path, list]) => {
    const tree = worktrees.find((t) => t.path === path);
    return list.map((name) => (worktrees.length > 1 && tree ? `${name} · ${worktreeLabel(tree)}` : name));
  });
  const said = [live > 0 ? `${live} running` : "None running", asking > 0 ? `${asking} to review` : null, ...names].filter(Boolean).join("\n");
  return (
    <button
      type="button"
      data-nav
      aria-current={open ? "page" : undefined}
      aria-label={`Commands: ${said}`}
      title={`Commands\n${said}`}
      onClick={onToggle}
      data-tauri-drag-region="false"
      className={`flex h-6 shrink-0 items-center gap-1 rounded-md text-[12px] outline-none transition-colors focus-visible:bg-hover ${live > 0 ? "pr-1.5 pl-1" : "w-6 justify-center"} ${
        open ? "bg-selected text-text" : "text-icon hover:bg-hover hover:text-text"
      }`}
    >
      <span className="relative grid place-items-center">
        <LayersIcon className="size-4 shrink-0" />
        {asking > 0 && <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-sidebar" />}
      </span>
      {live > 0 && <span className="tabular-nums">{live}</span>}
    </button>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const STICKY = "sticky top-0 z-10 bg-sidebar";

function HeaderButton({
  icon: Glyph,
  label,
  spinning = false,
  onClick,
  className = "",
}: {
  icon: Icon;
  label: string;
  spinning?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-tauri-drag-region="false"
      onClick={onClick}
      className={`grid size-6 shrink-0 place-items-center rounded-md text-icon outline-none transition-[color,background-color,opacity] hover:bg-hover hover:text-text focus-visible:bg-hover ${className}`}
    >
      <Glyph className={`size-4 ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

function NewSessionRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav
      onClick={onClick}
      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-text-muted outline-none hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <PlusIcon aria-hidden className="size-3.5 shrink-0" />
      New session
    </button>
  );
}

function loudest(sessions: Session[], activeId: string | null): SessionStatus {
  const dots = sessions.map((s) => dotOf(s, activeId));
  for (const status of ["needs-input", "error", "working", "starting", "background", "done"] as const) if (dots.includes(status)) return status;
  return "idle";
}

/**
 * A worktree's heading when sessions are grouped by it: a place, not a
 * selection. Its colour, its branch, its changes; the caret folds it, its plus
 * starts a session there, its menu holds the rest. Folded, its loudest dot.
 */
function WorktreeHeading({
  tree,
  open,
  count,
  loudest: status,
  showDiff,
  running,
  onFold,
  onAdd,
  onMenu,
}: {
  tree: Worktree;
  open: boolean;
  count: number;
  loudest: SessionStatus;
  showDiff: boolean;
  running: number;
  onFold: (open: boolean) => void;
  onAdd: () => void;
  onMenu: (point: MenuPoint) => void;
}) {
  return (
    <div className="group/tree relative">
      <button
        type="button"
        data-nav
        aria-expanded={open}
        title={tree.path}
        onClick={() => onFold(!open)}
        onContextMenu={(event) => onMenu(menuFromEvent(event))}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            onMenu(pointOf(event.currentTarget));
          }
        }}
        className="flex h-8 w-full items-center gap-2 rounded-chrome pr-2 pl-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <TreeGlyph tree={tree} className="size-3.5 text-icon group-hover/tree:hidden" />
          <ChevronRightIcon className={`hidden size-3.5 text-icon transition-transform group-hover/tree:block ${open ? "rotate-90" : ""}`} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{worktreeLabel(tree)}</span>
        <span className="flex shrink-0 items-center gap-2 transition-opacity group-hover/tree:opacity-0">
          {running > 0 && <LayersIcon className="size-3 text-success" />}
          {open && showDiff && (tree.add > 0 || tree.del > 0) && (
            <span className="text-[11px] tabular-nums">
              <span className="text-success">+{tree.add}</span> <span className="text-danger">−{tree.del}</span>
            </span>
          )}
          {!open && count > 0 && <span className="text-[11px] text-text-muted tabular-nums">{count}</span>}
          {!open && <StatusDot status={status} />}
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`New session in ${worktreeLabel(tree)}`}
        title={`New session in ${worktreeLabel(tree)}`}
        onClick={onAdd}
        className="absolute top-1 right-1 grid size-6 place-items-center rounded-md text-icon opacity-0 transition-opacity group-hover/tree:opacity-100 hover:bg-hover hover:text-text"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

function MoreRow({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: (open: boolean) => void }) {
  if (!open && hidden === 0) return null;
  return (
    <button
      type="button"
      data-nav
      aria-expanded={open}
      onClick={() => onToggle(!open)}
      className="mt-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-text-muted outline-none hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      {open ? <ChevronUpIcon aria-hidden className="size-3.5 shrink-0" /> : <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />}
      {open ? "Show less" : `${hidden} more`}
    </button>
  );
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
  const input = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  return (
    <div className="flex h-8 items-center gap-2 rounded-chrome bg-card pr-1 pl-2">
      <SearchIcon className="size-3.5 shrink-0 text-icon" />
      <input
        ref={input}
        value={query}
        placeholder="Find bots and sessions"
        aria-label="Find bots and sessions"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
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

// ── Bots and sessions ───────────────────────────────────────────────────────

type CardProps = {
  session: Session;
  prefs: SidebarPrefs;
  active: boolean;
  selected: boolean;
  /** Its status with pauses, failures and unread news folded in. */
  dot: SessionStatus;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  onMenu: (point: MenuPoint) => void;
  onClearSelection: () => void;
  onRemove: () => void;
};

const SURFACE = (active: boolean, selected: boolean) =>
  active ? "bg-selected" : selected ? "bg-selected/60" : "hover:bg-hover focus-visible:bg-hover";

const FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-border-strong";

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

/** A bot, as today: its face and its name, its status on the face's corner. */
function Tile({ session, active, selected, failed, onSelect, onMenu, onClearSelection, onRemove, onEdit }: CardProps & { failed: boolean; onEdit: () => void }) {
  return (
    <button
      type="button"
      data-nav
      data-session
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
        <BotAvatar seed={session.id} bare animated={session.status === "working"} className="size-10" />
        <Badge status={session.status} />
        {failed && (
          <span role="img" aria-label="A session it started failed" title="A session it started failed" className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-danger ring-2 ring-sidebar" />
        )}
      </span>
      <span className={`w-full truncate text-center text-[12px] ${active ? "font-medium" : ""}`}>{session.name}</span>
    </button>
  );
}

const BADGE: Partial<Record<SessionStatus, string>> = { "needs-input": "bg-warning", done: "bg-info", error: "bg-danger" };

function Badge({ status }: { status: SessionStatus }) {
  if (status === "idle" || status === "exited") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      className={`absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-sidebar ${status === "working" ? "opacity-0 motion-reduce:opacity-100" : ""}`}
    >
      {status === "working" || status === "starting" || status === "background" ? (
        <StatusDot status={status} className="size-3" />
      ) : (
        <span className={`size-2.5 rounded-full ${BADGE[status]}`} />
      )}
    </span>
  );
}

const titleOf = (session: Session) =>
  `${session.name} — ${providerLine(session.provider, session.model)}${session.launchedBy ? `\nStarted by ${session.launchedByName ?? "a session"}` : ""}`;

/** A session on one line, under its worktree's heading: what runs it, its name, when, its dot. */
function Line({ session, prefs, active, selected, dot, onSelect, onMenu, onClearSelection, onRemove, onRename }: CardProps & { onRename: () => void }) {
  return (
    <button
      type="button"
      data-nav
      data-session
      data-selected={selected || undefined}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(menuFromEvent(event))}
      onKeyDown={cardKeys({ rename: onRename, menu: onMenu, clear: onClearSelection, remove: onRemove })}
      title={titleOf(session)}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left transition-colors duration-150 ease-out ${SURFACE(active, selected)} ${FOCUS}`}
    >
      <ProviderIcon provider={session.provider} className="size-4" />
      <span className={`min-w-0 flex-1 truncate ${active || dot === "done" ? "font-medium" : ""}`}>{session.name}</span>
      {shows(prefs, "updated") && <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{elapsed(session.updatedAt)}</span>}
      {shows(prefs, "status") && <StatusDot status={dot} />}
    </button>
  );
}

/**
 * A session on two lines: what runs it, its name and its dot; under the name,
 * the worktree it belongs to and when it last moved. Renaming swaps the name
 * for the field and keeps the second line where it was.
 */
function TwoLines({
  session,
  prefs,
  active,
  selected,
  dot,
  place,
  editing,
  onSelect,
  onMenu,
  onClearSelection,
  onRemove,
  onRename,
}: CardProps & {
  place: { label: string; tree: Worktree | undefined };
  editing: { initial: string; onCommit: (name: string) => void; onCancel: () => void } | null;
  onRename: () => void;
}) {
  // The second line keeps the first's columns: the worktree's glyph sits under the provider's mark.
  const second = (
    <span className="flex h-4 min-w-0 items-center gap-2.5 text-[11.5px] text-text-muted">
      <span className="grid w-4 shrink-0 place-items-center">
        <TreeGlyph tree={place.tree} className="size-3 shrink-0" />
      </span>
      <span className="min-w-0 flex-1 truncate">{place.label}</span>
      {shows(prefs, "updated") && <span className="shrink-0 text-placeholder tabular-nums">{elapsed(session.updatedAt)}</span>}
    </span>
  );
  const icon = (
    <span className="grid w-4 shrink-0 place-items-center">
      <ProviderIcon provider={session.provider} className="size-4" />
    </span>
  );
  if (editing)
    return (
      // Only the field has a ground while renaming: the row's own falls away.
      <div className="flex w-full flex-col gap-0.5 rounded-chrome px-2 py-1">
        <span className="flex h-6 items-center gap-2.5">
          {icon}
          <RenameRow className="-ml-2 h-6" {...editing} />
        </span>
        {second}
      </div>
    );
  return (
    <button
      type="button"
      data-nav
      data-session
      data-selected={selected || undefined}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(menuFromEvent(event))}
      onKeyDown={cardKeys({ rename: onRename, menu: onMenu, clear: onClearSelection, remove: onRemove })}
      title={titleOf(session)}
      aria-current={active ? "page" : undefined}
      className={`flex w-full flex-col gap-0.5 rounded-chrome px-2 py-1 text-left transition-colors duration-150 ease-out ${SURFACE(active, selected)} ${FOCUS}`}
    >
      <span className="flex h-6 items-center gap-2.5">
        {icon}
        <span className={`min-w-0 flex-1 truncate ${active || dot === "done" ? "font-medium" : ""}`}>{session.name}</span>
        {shows(prefs, "status") && <StatusDot status={dot} />}
      </span>
      {second}
    </button>
  );
}

