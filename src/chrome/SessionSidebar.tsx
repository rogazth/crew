import { Sidebar } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  GearIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ActionMenu } from "./ActionMenu";
import { AgentAvatar } from "./AgentAvatar";
import { DELETE, EDIT, RENAME, menuFromEvent, type MenuPoint } from "../lib/menu";
import { ProviderIcon } from "./ProviderIcon";
import { RenameRow } from "./RenameRow";
import { Section } from "./Section";
import { SidebarPrefsMenu } from "./SidebarPrefsMenu";
import { SidebarRow } from "./SidebarRow";
import { SortableItem, SortableList } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { WorkspacePicker } from "./WorkspacePicker";
import { useSidebarPrefs } from "../hooks/useSidebarPrefs";
import { commandKeys } from "../lib/commands";
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
  canReorder,
  groupSessions,
  shows,
  type SessionGroup,
  type SidebarPrefs,
} from "../lib/sidebarPrefs";
import { elapsed } from "../lib/time";
import type { Session, Workspace } from "../lib/types";

export type SessionSidebarProps = {
  workspace: Workspace;
  workspaces: Workspace[];
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onRemoveWorkspace: (workspace: Workspace) => void;
  onReorderWorkspaces: (ids: string[]) => void;
  sessions: Session[];
  activeSessionId: string | null;
  settingsOpen: boolean;
  routinesOpen: boolean;
  onSelect: (session: Session) => void;
  onNewAgent: () => void;
  onNewSession: () => void;
  onOpenRoutines: () => void;
  onOpenSettings: () => void;
  onEdit: (session: Session) => void;
  onRename: (session: Session, name: string) => void;
  onRemove: (session: Session) => void;
  onRemoveMany: (sessions: Session[]) => void;
  onReorder: (ids: string[]) => void;
};

type Menu = { point: MenuPoint; session: Session };

function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): ClickModifiers {
  return { toggle: IS_MAC ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

/** The sidebar's default view: workspace switcher, actions, session list, settings row. */
export function SessionSidebar(props: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useSidebarPrefs();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const filtering = query.trim().length > 0;

  const groups = useMemo(
    () => (prefs ? groupSessions(props.sessions, prefs, query) : []),
    [props.sessions, prefs, query],
  );
  const order = useMemo(
    () => groups.flatMap((group) => group.sessions.map((session) => session.id)),
    [groups],
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

  const selectedSessions = () =>
    props.sessions.filter((session) => selected.has(session.id));

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

  const clearSelection = () => setHeld(null);

  return (
    <>
      {/* Only the traffic-light reserve lives up here; every action is a row below,
          so the strip stays a drag region and no hairline cuts the rail. */}
      <Sidebar.Header data-tauri-drag-region className="h-10 shrink-0 border-b-0 p-0">
        {IS_MAC && <div className="h-full w-[78px]" />}
      </Sidebar.Header>

      {/* The identity row sits apart from the actions, so the sidebar reads top-down: where, then what. */}
      <div className="shrink-0 px-[11px] pb-3">
        <WorkspacePicker
          workspaces={props.workspaces}
          activeId={props.workspace.id}
          open={props.pickerOpen}
          onOpenChange={props.onPickerOpenChange}
          onSelect={props.onSelectWorkspace}
          onCreate={props.onCreateWorkspace}
          onRename={props.onRenameWorkspace}
          onRemove={props.onRemoveWorkspace}
          onReorder={props.onReorderWorkspaces}
        />
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-[11px] pb-3">
        <SidebarRow
          icon={RobotIcon}
          label="New agent"
          keys={commandKeys("new-agent")}
          onClick={props.onNewAgent}
        />
        <SidebarRow
          icon={TerminalWindowIcon}
          label="New session"
          keys={commandKeys("new-session")}
          onClick={props.onNewSession}
        />
        <SidebarRow
          icon={ArrowsClockwiseIcon}
          label="Routines"
          active={props.routinesOpen}
          onClick={props.onOpenRoutines}
        />
      </div>

      {/* The search belongs to the list under it, so the gap below is a beat, not a section break. */}
      <div className="shrink-0 px-[11px]">
        <div className="flex h-8 items-center gap-2.5 rounded-md bg-kumo-control pr-1 pl-2 ring ring-kumo-line has-[input:focus]:ring-[1.5px] has-[input:focus]:ring-kumo-focus/50">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-kumo-subtle" />
          <input
            value={query}
            placeholder="Search"
            aria-label="Find agents and sessions"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setQuery("");
              event.currentTarget.blur();
            }}
            className="h-full min-w-0 flex-1 bg-transparent py-0 outline-none"
          />
          {prefs && <SidebarPrefsMenu prefs={prefs} onChange={setPrefs} />}
        </div>
      </div>

      <Sidebar.Content className="min-h-0 flex-1">
        {prefs &&
          groups.map((group) => (
            <Group
              key={group.id}
              group={group}
              prefs={prefs}
              filtering={filtering}
              renaming={renaming}
              activeSessionId={props.activeSessionId}
              selected={selected}
              onAdd={addFor(group, props)}
              onPick={pick}
              onMenu={(point, session) => {
                if (!selected.has(session.id))
                  setSelection({ ids: [session.id], anchor: session.id });
                setMenu({ point, session });
              }}
              onClearSelection={clearSelection}
              onStartRename={setRenaming}
              onRename={props.onRename}
              onRemove={removeFrom}
              onReorder={props.onReorder}
            />
          ))}
        {prefs && groups.length === 0 && (
          <p className="px-2 py-1.5 text-placeholder">
            {filtering ? "No matches" : "Nothing here yet"}
          </p>
        )}
      </Sidebar.Content>

      <Sidebar.Footer className="h-auto shrink-0 flex-col items-stretch border-t-0 px-[11px] py-2">
        <SidebarRow
          icon={GearIcon}
          label="Settings"
          keys={commandKeys("open-settings")}
          active={props.settingsOpen}
          onClick={props.onOpenSettings}
        />
      </Sidebar.Footer>

      {menu && (
        <ActionMenu
          key={menu.session.id}
          point={menu.point}
          actions={
            selected.size > 1 && selected.has(menu.session.id)
              ? [{ ...DELETE, label: `Delete ${selected.size} items` }]
              : menu.session.kind === "agent"
                ? [EDIT, DELETE]
                : [RENAME, DELETE]
          }
          onPick={(id) => {
            const session = menu.session;
            setMenu(null);
            if (id === "rename") {
              queueMicrotask(() => setRenaming(session.id));
              return;
            }
            if (id === "edit") props.onEdit(session);
            if (id === "delete") removeFrom(session);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Only a group that holds one kind knows what its plus would create. */
function addFor(group: SessionGroup, props: SessionSidebarProps) {
  if (group.kind === "agent") return { onAdd: props.onNewAgent, hint: `New agent ${commandKeys("new-agent")}` };
  if (group.kind === "terminal")
    return { onAdd: props.onNewSession, hint: `New session ${commandKeys("new-session")}` };
  return null;
}

type GroupProps = {
  group: SessionGroup;
  prefs: SidebarPrefs;
  filtering: boolean;
  renaming: string | null;
  activeSessionId: string | null;
  selected: Set<string>;
  onAdd: { onAdd: () => void; hint: string } | null;
  onPick: (session: Session, modifiers: ClickModifiers) => void;
  onMenu: (point: MenuPoint, session: Session) => void;
  onClearSelection: () => void;
  onStartRename: (id: string | null) => void;
  onRename: (session: Session, name: string) => void;
  onRemove: (session: Session) => void;
  onReorder: (ids: string[]) => void;
};

function Group({
  group,
  prefs,
  filtering,
  renaming,
  activeSessionId,
  selected,
  onAdd,
  ...on
}: GroupProps) {
  const ids = useMemo(() => group.sessions.map((session) => session.id), [group.sessions]);
  const draggable = canReorder(prefs, filtering) && renaming === null;

  const list = (
    <SortableList ids={ids} disabled={!draggable} onReorder={on.onReorder}>
      {group.sessions.map((session, index) => (
        <SortableItem
          key={session.id}
          id={session.id}
          index={index}
          group={group.id}
          disabled={!draggable}
        >
          <Sidebar.MenuItem>
            {session.id === renaming ? (
              <RenameRow
                className="min-h-11.5 px-2"
                initial={session.name}
                onCommit={(name) => {
                  on.onRename(session, name);
                  on.onStartRename(null);
                }}
                onCancel={() => on.onStartRename(null)}
              />
            ) : (
              <Card
                session={session}
                prefs={prefs}
                active={session.id === activeSessionId}
                selected={selected.has(session.id)}
                onSelect={(event) => on.onPick(session, modifiersOf(event))}
                onContextMenu={(event) => on.onMenu(menuFromEvent(event), session)}
                onClearSelection={on.onClearSelection}
                onRemove={() => on.onRemove(session)}
                {...(session.kind === "terminal"
                  ? { onRename: () => on.onStartRename(session.id) }
                  : {})}
              />
            )}
          </Sidebar.MenuItem>
        </SortableItem>
      ))}
    </SortableList>
  );

  // Ungrouped is a flat list, not a group called "All".
  if (prefs.grouping === "none") {
    return (
      <Sidebar.Group className="p-0">
        <Sidebar.Menu className="gap-0.5">{list}</Sidebar.Menu>
      </Sidebar.Group>
    );
  }

  return (
    <Section label={group.label} onAdd={onAdd?.onAdd} addHint={onAdd?.hint}>
      {list}
    </Section>
  );
}

/** A session row without its third line; what it prints is the Show preference. */
function Card({
  session,
  prefs,
  active,
  selected,
  onSelect,
  onContextMenu,
  onClearSelection,
  onRename,
  onRemove,
}: {
  session: Session;
  prefs: SidebarPrefs;
  active: boolean;
  selected: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onClearSelection: () => void;
  onRename?: () => void;
  onRemove: () => void;
}) {
  const avatar = session.kind === "agent" && shows(prefs, "avatar");
  const meta = shows(prefs, "provider");

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2" && onRename) {
      event.preventDefault();
      onRename();
      return;
    }
    if (event.key === "Escape") {
      onClearSelection();
      return;
    }
    if (isDeleteChord(event)) {
      event.preventDefault();
      onRemove();
    }
  }

  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      data-selected={selected || undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={session.description || session.name}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-chrome px-2 py-1.5 text-left outline-none transition-colors duration-150 ease-out ${
        active ? "bg-card" : selected ? "bg-selected" : "hover:bg-hover focus-visible:bg-hover"
      }`}
    >
      {avatar && (
        <AgentAvatar seed={session.id} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{session.name}</span>
          {shows(prefs, "updated") && (
            <span className="shrink-0 text-[12px] text-kumo-subtle tabular-nums">
              {elapsed(session.updatedAt)}
            </span>
          )}
        </span>
        {meta && (
          <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
            <ProviderIcon provider={session.provider} className="size-3.5" />
            <span className="min-w-0 truncate">
              {providerLine(session.provider, session.model)}
            </span>
          </span>
        )}
      </span>
      {shows(prefs, "status") && <StatusDot status={session.status} />}
    </button>
  );
}
