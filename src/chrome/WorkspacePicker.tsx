import { Popover } from "@base-ui/react/popover";
import {
  CaretUpDownIcon,
  CheckIcon,
  FolderIcon,
  FolderPlusIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ActionMenu, DELETE, menuFromEvent, type MenuPoint } from "./ActionMenu";
import { SortableItem, SortableList } from "./SortableList";
import { commandKeys } from "../lib/commands";
import { isDeleteChord } from "../lib/hotkey";
import { filterWorkspaces } from "../lib/workspaces";
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

/**
 * The whole workspace surface: switch, search, reorder, rename, remove.
 * Replaces the old rail — a second permanent column for a list this short did not pay for itself.
 */
export function WorkspacePicker(props: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const active = props.workspaces.find((workspace) => workspace.id === props.activeId);
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

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <Popover.Trigger
        data-tauri-drag-region="false"
        title={active?.path}
        className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-kumo-default outline-none transition-colors hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
      >
        <FolderIcon className="size-4 shrink-0 text-kumo-subtle" />
        <span className="min-w-0 flex-1 truncate">
          {active?.name ?? "No workspace"}
        </span>
        <CaretUpDownIcon className="size-3.5 shrink-0 text-kumo-subtle" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Popover.Popup
            // The search field is the point of ⌘K, so it takes focus on open.
            initialFocus={search}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, visible.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const workspace = visible[cursor];
                if (workspace) pick(workspace.id);
              }
            }}
            className="w-72 origin-(--transform-origin) overflow-hidden rounded-lg bg-kumo-control text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            <div className="flex h-9 items-center gap-2 border-b border-kumo-line px-2.5">
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

            <div className="max-h-72 overflow-y-auto p-1">
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

            <div className="border-t border-kumo-line p-1">
              <button
                type="button"
                onClick={() => {
                  props.onCreate();
                  props.onOpenChange(false);
                }}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-hover"
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

function Row({
  workspace,
  active,
  hovered,
  onSelect,
  onHover,
  onOpenMenu,
  onRemove,
}: {
  workspace: Workspace;
  active: boolean;
  hovered: boolean;
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
      onClick={onSelect}
      onMouseEnter={onHover}
      onContextMenu={(event) => onOpenMenu(menuFromEvent(event))}
      onKeyDown={onKeyDown}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none ${
        hovered ? "bg-hover" : ""
      }`}
    >
      <FolderIcon className="size-4 shrink-0 text-kumo-subtle" />
      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
      {active && <CheckIcon className="size-4 shrink-0" />}
    </button>
  );
}
