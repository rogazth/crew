import { Button, Sidebar } from "@cloudflare/kumo";
import {
  FileMagnifyingGlassIcon,
  GearIcon,
  MagnifyingGlassIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ActionMenu, DELETE, EDIT, RENAME, menuFromEvent, type MenuPoint } from "./ActionMenu";
import { ProviderIcon } from "./ProviderIcon";
import { RenameRow } from "./RenameRow";
import { Section } from "./Section";
import { SessionFiltersMenu } from "./SessionFiltersMenu";
import { SortableItem, SortableList } from "./SortableList";
import { Kbd } from "./Kbd";
import { StatusDot } from "./StatusDot";
import { WorkspacePicker } from "./WorkspacePicker";
import { useCommand } from "../hooks/useCommand";
import { commandKeys } from "../lib/commands";
import { IS_MAC, isDeleteChord } from "../lib/hotkey";
import { providerLine } from "../lib/providers";
import { applyFilters, NO_FILTERS, type SessionFilters } from "../lib/sessionFilters";
import { elapsed } from "../lib/time";
import type { Session, Workspace } from "../lib/types";
import { filterSessions } from "../lib/workspaces";

type Props = {
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
  onSelect: (session: Session) => void;
  onNewAgent: () => void;
  onNewSession: () => void;
  onSearch: () => void;
  onOpenSettings: () => void;
  onEdit: (session: Session) => void;
  onRename: (session: Session, name: string) => void;
  onRemove: (session: Session) => void;
  onReorder: (ids: string[]) => void;
};

type Menu = { point: MenuPoint; session: Session };

/** The app's only sidebar: workspace switcher, session list, settings. */
export function SessionSidebar(props: Props) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SessionFilters>(NO_FILTERS);
  const search = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const filtering = query.trim().length > 0;

  const visible = useMemo(() => applyFilters(props.sessions, filters), [props.sessions, filters]);
  const agents = useMemo(
    () => filterSessions(visible.filter((s) => s.kind === "agent"), query),
    [visible, query],
  );
  const terminals = useMemo(
    () => filterSessions(visible.filter((s) => s.kind === "terminal"), query),
    [visible, query],
  );
  const agentIds = useMemo(() => agents.map((session) => session.id), [agents]);
  const terminalIds = useMemo(() => terminals.map((session) => session.id), [terminals]);

  useCommand("find-in-sidebar", () => search.current?.select());

  function row(session: Session, index: number) {
    const locked = filtering || renaming !== null;
    return (
      <SortableItem
        key={session.id}
        id={session.id}
        index={index}
        group={session.kind}
        disabled={locked}
      >
        <Sidebar.MenuItem>
          {session.id === renaming ? (
            <RenameRow
              className="min-h-13.5 px-2.5"
              initial={session.name}
              onCommit={(name) => {
                props.onRename(session, name);
                setRenaming(null);
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <Card
              session={session}
              active={session.id === props.activeSessionId}
              onSelect={() => props.onSelect(session)}
              onContextMenu={(event) => setMenu({ point: menuFromEvent(event), session })}
              onRemove={() => props.onRemove(session)}
              {...(session.kind === "terminal" ? { onRename: () => setRenaming(session.id) } : {})}
            />
          )}
        </Sidebar.MenuItem>
      </SortableItem>
    );
  }

  return (
    <Sidebar className="bg-sidebar" contentClassName="flex h-full flex-col">
      {/* Title row: R1's h-10, holding the traffic-light reserve and the
          window-level action. Nothing here scrolls, so it stays a drag region. */}
      <Sidebar.Header
        data-tauri-drag-region
        className="flex h-10 shrink-0 flex-row items-center gap-1 border-b-0 py-0 pr-1.5 pl-1.5"
      >
        {IS_MAC && <div className="w-[78px] shrink-0" />}
        <div className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={FileMagnifyingGlassIcon}
          aria-label="Go to file"
          title={`Go to file ${commandKeys("go-to-file")}`}
          onClick={props.onSearch}
          className="size-7 [&_svg]:size-4"
        />
      </Sidebar.Header>

      {/* Workspace row, then the session filter — R1's SidebarProjectPicker stack. */}
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-0.5 border-y border-border px-2"
      >
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
        <SessionFiltersMenu filters={filters} onChange={setFilters} />
      </div>

      <div className="flex h-9 shrink-0 items-center border-b border-border px-2">
        <div className="relative flex h-7 min-w-0 flex-1 items-center">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2 size-3.5 shrink-0 text-kumo-subtle" />
          <input
            ref={search}
            value={query}
            placeholder="Find agents and sessions"
            aria-label="Find agents and sessions"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (query) setQuery("");
              else search.current?.blur();
            }}
            className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pr-10 pl-7 outline-none"
          />
          <Kbd keys={commandKeys("find-in-sidebar")} className="absolute right-2" />
        </div>
      </div>

      <Sidebar.Content className="min-h-0 flex-1">
        <Section label="Agents" onAdd={props.onNewAgent} addHint={`New agent ${commandKeys("new-agent")}`}>
          <SortableList ids={agentIds} disabled={filtering} onReorder={props.onReorder}>
            {agents.map((session, index) => row(session, index))}
          </SortableList>
          {agents.length === 0 && <Hint text={filtering ? "No matches" : "No agents yet"} />}
        </Section>
        <Section label="Sessions" onAdd={props.onNewSession} addHint={`New session ${commandKeys("new-session")}`}>
          <SortableList ids={terminalIds} disabled={filtering} onReorder={props.onReorder}>
            {terminals.map((session, index) => row(session, index))}
          </SortableList>
          {terminals.length === 0 && <Hint text={filtering ? "No matches" : "No sessions yet"} />}
        </Section>
      </Sidebar.Content>

      {/* R1 pins Settings to the sidebar's floor, as a full row with its shortcut. */}
      <Sidebar.Footer className="h-auto shrink-0 flex-col items-stretch border-t-0 p-2">
        <button
          type="button"
          onClick={props.onOpenSettings}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
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
          actions={menu.session.kind === "agent" ? [EDIT, DELETE] : [RENAME, DELETE]}
          onPick={(id) => {
            const session = menu.session;
            setMenu(null);
            if (id === "rename") {
              queueMicrotask(() => setRenaming(session.id));
              return;
            }
            if (id === "edit") props.onEdit(session);
            if (id === "delete") props.onRemove(session);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </Sidebar>
  );
}

/** R1's SessionCard minus its third row; agents get a generic avatar, sessions do not. */
function Card({
  session,
  active,
  onSelect,
  onContextMenu,
  onRename,
  onRemove,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onRename?: () => void;
  onRemove: () => void;
}) {
  const agent = session.kind === "agent";

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2" && onRename) {
      event.preventDefault();
      onRename();
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
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={session.description || session.name}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:bg-(--sidebar-active-bg) ${
        active ? "bg-(--sidebar-active-bg)" : "hover:bg-(--sidebar-active-bg)"
      }`}
    >
      {agent && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-subtle">
          <RobotIcon className="size-4.5" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ProviderIcon provider={session.provider} className="size-3.5" />
            <span className="min-w-0 truncate text-[11px] text-kumo-subtle">
              {providerLine(session.provider, session.model)}
            </span>
          </span>
          <StatusDot status={session.status} />
          <span className="shrink-0 text-[11px] text-kumo-subtle tabular-nums">
            {elapsed(session.updatedAt)}
          </span>
        </span>
        <span className="mt-1 line-clamp-1 text-[13px] leading-snug font-semibold text-kumo-default">
          {session.name}
        </span>
      </span>
    </button>
  );
}

function Hint({ text }: { text: string }) {
  return <p className="px-2 py-1.5 text-placeholder">{text}</p>;
}
