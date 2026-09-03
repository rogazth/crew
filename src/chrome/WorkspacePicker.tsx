import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  CheckIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ActionMenu, DELETE, menuFromEvent, type MenuPoint } from "./ActionMenu";
import { SortableItem, SortableList } from "./SortableList";
import { commandKeys, type CommandId } from "../lib/commands";
import { isDeleteChord } from "../lib/hotkey";
import { filterWorkspaces, shortenPath, workspaceMark } from "../lib/workspaces";
import type { Workspace } from "../lib/types";

type Props = {
  workspaces: Workspace[];
  activeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (workspace: Workspace) => void;
  onReorder: (ids: string[]) => void;
};

type Menu = { point: MenuPoint; workspace: Workspace };

/** Past this many the list stops fitting in one glance and earns a search field. */
const SEARCHABLE_FROM = 8;

/** ⌃⌘1‥9 jump straight to a row; the hint on the row teaches the chord. */
function jumpCommand(index: number): CommandId | null {
  return index < 9 ? (`workspace-${index + 1}` as CommandId) : null;
}

/**
 * The whole workspace surface: switch, search, reorder, rename, remove. The
 * trigger is the sidebar's identity row, Linear-style: mark, name, chevron.
 */
export function WorkspacePicker(props: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const active = props.workspaces.find((workspace) => workspace.id === props.activeId);
  const searchable = props.workspaces.length >= SEARCHABLE_FROM;
  const filtering = query.trim().length > 0;
  const visible = useMemo(
    () => filterWorkspaces(props.workspaces, query),
    [props.workspaces, query],
  );
  const ids = useMemo(() => visible.map((workspace) => workspace.id), [visible]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);

  function pick(id: string) {
    props.onSelect(id);
    props.onOpenChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, visible.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const workspace = visible[cursor];
      if (workspace) pick(workspace.id);
      return;
    }
    // Bare digits pick a row while the list, not a search field, holds focus.
    if (!filtering && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      const workspace = visible[Number(event.key) - 1];
      if (workspace) {
        event.preventDefault();
        pick(workspace.id);
      }
    }
  }

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <Popover.Trigger
        data-tauri-drag-region="false"
        title={active?.path}
        className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-kumo-default outline-none transition-colors hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
      >
        <Mark name={active?.name ?? "?"} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {active?.name ?? "No workspace"}
        </span>
        <CaretDownIcon
          weight="bold"
          className="size-3 shrink-0 text-kumo-subtle transition-transform duration-200 group-data-popup-open:rotate-180"
        />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Popover.Popup
            initialFocus={searchable ? search : list}
            onKeyDown={onKeyDown}
            className="w-[280px] origin-(--transform-origin) overflow-hidden rounded-xl bg-kumo-control text-kumo-default shadow-xl ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
          >
            {searchable && (
              <div className="flex h-9 items-center gap-2.5 border-b border-kumo-line px-3">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-kumo-subtle" />
                <input
                  ref={search}
                  value={query}
                  placeholder="Search workspaces"
                  aria-label="Search workspaces"
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-full min-w-0 flex-1 bg-transparent outline-none"
                />
              </div>
            )}

            <div
              ref={list}
              tabIndex={-1}
              aria-label="Workspaces"
              className="max-h-80 overflow-y-auto p-1.5 outline-none"
            >
              <SortableList ids={ids} disabled={filtering} onReorder={props.onReorder}>
                {visible.map((workspace, index) => (
                  <SortableItem
                    key={workspace.id}
                    id={workspace.id}
                    index={index}
                    group="workspace"
                    disabled={filtering}
                  >
                    <Row
                      workspace={workspace}
                      active={workspace.id === props.activeId}
                      hovered={index === cursor}
                      jump={filtering ? null : jumpCommand(index)}
                      onSelect={() => pick(workspace.id)}
                      onHover={() => setCursor(index)}
                      onOpenMenu={(point) => setMenu({ point, workspace })}
                      onRemove={() => props.onRemove(workspace)}
                    />
                  </SortableItem>
                ))}
              </SortableList>
              {visible.length === 0 && (
                <p className="px-2.5 py-6 text-center text-placeholder">No matches</p>
              )}
            </div>

            <div className="border-t border-kumo-line p-1.5">
              <button
                type="button"
                onClick={() => {
                  props.onCreate();
                  props.onOpenChange(false);
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-hover"
              >
                <FolderPlusIcon className="size-4 shrink-0 text-kumo-subtle" />
                <span className="min-w-0 flex-1 truncate">Open workspace…</span>
                <span className="shrink-0 text-[11px] text-kumo-subtle">
                  {commandKeys("open-workspace")}
                </span>
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>

      {menu && (
        <ActionMenu
          key={menu.workspace.id}
          point={menu.point}
          rename={{
            initial: menu.workspace.name,
            onCommit: (name) => props.onRename(menu.workspace.id, name),
          }}
          actions={[DELETE]}
          onPick={(id) => {
            const workspace = menu.workspace;
            setMenu(null);
            if (id === "delete") props.onRemove(workspace);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </Popover.Root>
  );
}

/** A folder has no icon of its own, so its initials stand in, like a Slack team mark. */
function Mark({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-kumo-brand text-[10px] font-semibold tracking-wide text-kumo-inverse ${className}`}
    >
      {workspaceMark(name)}
    </span>
  );
}

function Row({
  workspace,
  active,
  hovered,
  jump,
  onSelect,
  onHover,
  onOpenMenu,
  onRemove,
}: {
  workspace: Workspace;
  active: boolean;
  hovered: boolean;
  jump: CommandId | null;
  onSelect: () => void;
  onHover: () => void;
  onOpenMenu: (point: MenuPoint) => void;
  onRemove: () => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2") {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenMenu({ x: rect.left, y: rect.bottom });
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
      title={workspace.path}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      onMouseEnter={onHover}
      onContextMenu={(event) => onOpenMenu(menuFromEvent(event))}
      onKeyDown={onKeyDown}
      className={`flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none ${
        hovered ? "bg-hover" : ""
      }`}
    >
      <Mark name={workspace.name} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate font-medium">{workspace.name}</span>
        <span className="truncate text-[11px] text-kumo-subtle">{shortenPath(workspace.path)}</span>
      </span>
      {active ? (
        <CheckIcon weight="bold" className="size-3.5 shrink-0" />
      ) : (
        jump && (
          <span className="shrink-0 text-[11px] text-kumo-subtle tabular-nums">
            {commandKeys(jump)}
          </span>
        )
      )}
    </button>
  );
}
