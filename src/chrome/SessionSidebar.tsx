import { Button, Sidebar } from "@cloudflare/kumo";
import { GearIcon, MagnifyingGlassIcon, PlusIcon, RobotIcon } from "@phosphor-icons/react";
import { Popover } from "@base-ui/react/popover";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ActionMenu, DELETE, EDIT, RENAME, menuFromEvent, type MenuPoint } from "./ActionMenu";
import { ProviderIcon } from "./ProviderIcon";
import { RenameRow } from "./RenameRow";
import { Section } from "./Section";
import { SidebarPrefsMenu } from "./SidebarPrefsMenu";
import { SortableItem, SortableList } from "./SortableList";
import { Kbd } from "./Kbd";
import { StatusDot } from "./StatusDot";
import { WorkspacePicker } from "./WorkspacePicker";
import { useCommand } from "../hooks/useCommand";
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
  onSelect: (session: Session) => void;
  onNewAgent: () => void;
  onNewSession: () => void;
  onSearch: () => void;
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

/** The sidebar's default view: workspace switcher, find, session list, settings row. */
export function SessionSidebar(props: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useSidebarPrefs();
  const search = useRef<HTMLInputElement>(null);
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

  useCommand("find-in-sidebar", () => search.current?.select());

  return (
    <>
      {/* Title row: R1's h-10, holding the traffic-light reserve and the
          window-level actions. Nothing here scrolls, so it stays a drag region. */}
      <Sidebar.Header
        data-tauri-drag-region
        className="flex h-10 shrink-0 flex-row items-center gap-1 border-b border-border py-0 pr-1.5 pl-1.5"
      >
        {IS_MAC && <div className="w-[78px] shrink-0" />}
        <div className="min-w-0 flex-1" />
        <NewMenu onNewAgent={props.onNewAgent} onNewSession={props.onNewSession} />
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={MagnifyingGlassIcon}
          aria-label="Search"
          title={`Search ${commandKeys("open-palette")}`}
          onClick={props.onSearch}
          className="size-7 [&_svg]:size-4"
        />
      </Sidebar.Header>

      {/* Workspace and find share one block, so only its floor carries a line. */}
      <div data-tauri-drag-region className="flex h-9 shrink-0 items-center px-2">
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

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {/* The keycap is a flex sibling, not an overlay: a wider chord shortens the
            field instead of landing on top of the placeholder. */}
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-kumo-fill px-2 ring-kumo-interact focus-within:ring-1">
          <MagnifyingGlassIcon className="size-3.5 shrink-0 text-kumo-subtle" />
          <input
            ref={search}
            value={query}
            placeholder="Find…"
            aria-label="Find agents and sessions"
            title="Find agents and sessions"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (query) setQuery("");
              else search.current?.blur();
            }}
            className="peer h-full min-w-0 flex-1 bg-transparent py-0 outline-none"
          />
          {!query && (
            <Kbd keys={commandKeys("find-in-sidebar")} className="shrink-0 peer-focus:hidden" />
          )}
        </div>
        {prefs && <SidebarPrefsMenu prefs={prefs} onChange={setPrefs} />}
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

      {/* R1 pins Settings to the sidebar's floor, as a full row with its shortcut. */}
      <Sidebar.Footer className="h-auto shrink-0 flex-col items-stretch border-t-0 p-2">
        <button
          type="button"
          onClick={props.onOpenSettings}
          aria-current={props.settingsOpen ? "page" : undefined}
          className={`relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors ${
            props.settingsOpen
              ? "bg-selected text-kumo-default before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-kumo-default"
              : "text-kumo-subtle hover:bg-hover hover:text-kumo-default"
          }`}
        >
          <GearIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium">Settings</span>
          <span className="shrink-0 text-[11px] text-kumo-subtle">
            {commandKeys("open-settings")}
          </span>
        </button>
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

  return (
    <Section label={group.label} onAdd={onAdd?.onAdd} addHint={onAdd?.hint}>
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
                  className="min-h-13.5 px-2.5"
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
    </Section>
  );
}

function NewMenu({
  onNewAgent,
  onNewSession,
}: {
  onNewAgent: () => void;
  onNewSession: () => void;
}) {
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger
        aria-label="New"
        title="New"
        data-tauri-drag-region="false"
        className="grid size-7 shrink-0 place-items-center rounded-md text-kumo-subtle outline-none transition-colors hover:bg-hover hover:text-kumo-default data-popup-open:bg-hover data-popup-open:text-kumo-default"
      >
        <PlusIcon className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Popover.Popup className="w-48 origin-(--transform-origin) rounded-lg bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
          <Popover.Close
            render={
              <button
                type="button"
                onClick={onNewAgent}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">New agent</span>
                <Kbd keys={commandKeys("new-agent")} />
              </button>
            }
          />
          <Popover.Close
            render={
              <button
                type="button"
                onClick={onNewSession}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">New session</span>
                <Kbd keys={commandKeys("new-session")} />
              </button>
            }
          />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** R1's SessionCard minus its third row; what it prints is the Show preference. */
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
  const meta =
    shows(prefs, "provider") || shows(prefs, "status") || shows(prefs, "updated");

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
      className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors ${
        active
          ? "bg-selected before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-kumo-default"
          : selected
            ? "bg-selected"
            : "hover:bg-hover focus-visible:bg-hover"
      }`}
    >
      {avatar && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle">
          <RobotIcon className="size-4.5" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {meta && (
          <span className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {shows(prefs, "provider") && (
                <>
                  <ProviderIcon provider={session.provider} className="size-3.5" />
                  <span className="min-w-0 truncate text-[11px] text-kumo-subtle">
                    {providerLine(session.provider, session.model)}
                  </span>
                </>
              )}
            </span>
            {shows(prefs, "status") && <StatusDot status={session.status} />}
            {shows(prefs, "updated") && (
              <span className="shrink-0 text-[11px] text-kumo-subtle tabular-nums">
                {elapsed(session.updatedAt)}
              </span>
            )}
          </span>
        )}
        <span
          className={`line-clamp-1 text-[13px] leading-snug font-semibold text-kumo-default ${
            meta ? "mt-1" : ""
          }`}
        >
          {session.name}
        </span>
      </span>
    </button>
  );
}
