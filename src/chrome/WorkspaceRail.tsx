import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { PlusIcon, RefreshCwIcon, SettingsIcon, type LucideIcon as Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ActionMenu } from "./ActionMenu";
import { SortableItem, SortableList } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { commandKeys, type CommandId } from "../lib/commands";
import { isDeleteChord } from "../lib/hotkey";
import { COPY_PATH, DELETE, SEPARATOR, menuFromEvent, type MenuPoint } from "../lib/menu";
import { STATUS_ORDER } from "../lib/status";
import type { Session, SessionStatus, Workspace } from "../lib/types";
import { workspaceMark } from "../lib/workspaces";

type Props = {
  workspaces: Workspace[];
  activeId: string;
  /** Every workspace's sessions, so a workspace out of sight can still call for attention. */
  sessions: Session[];
  settingsOpen: boolean;
  routinesOpen: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (workspace: Workspace) => void;
  onReorder: (ids: string[]) => void;
  onOpenRoutines: () => void;
  onOpenSettings: () => void;
};

type Menu = { point: MenuPoint; workspace: Workspace };

/** The marks slide along the rail only, and never past its ends. */
const RAIL_MODIFIERS = [
  RestrictToVerticalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[data-rail-marks]") ?? null,
  }),
];

/** ⌘1‥9 jump straight to a mark; the tooltip teaches the chord. */
function jumpKeys(index: number): string {
  return index < 9 ? commandKeys(`workspace-${index + 1}` as CommandId) : "";
}

/** What a workspace out of sight has to say: the loudest status among its sessions, idle and read ones aside. */
function loudest(sessions: Session[]): SessionStatus | null {
  for (const status of STATUS_ORDER) {
    if (status === "idle") return null;
    if (sessions.some((session) => session.status === status)) return status;
  }
  return null;
}

/**
 * Workspaces as a rail of marks, Slack-style: always in sight, reordered by
 * dragging, switched by ⌘1‥9 or the arrows. Routines and settings sit at its foot.
 */
export function WorkspaceRail(props: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const ids = useMemo(() => props.workspaces.map((workspace) => workspace.id), [props.workspaces]);
  const byWorkspace = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of props.sessions) {
      const list = map.get(session.workspaceId);
      if (list) list.push(session);
      else map.set(session.workspaceId, [session]);
    }
    return map;
  }, [props.sessions]);

  return (
    <nav
      data-sidebar-rail
      aria-label="Workspaces"
      className="flex min-h-0 w-[52px] shrink-0 flex-col items-center gap-2 pt-1 pb-3"
    >
      {/* The marks scroll; the + under them and the foot stay put, however many there are. */}
      <RailScroll activeId={props.activeId}>
      <div data-rail-marks className="flex flex-col items-center gap-2">
        <SortableList ids={ids} onReorder={props.onReorder} modifiers={RAIL_MODIFIERS}>
          {props.workspaces.map((workspace, index) => (
            <SortableItem key={workspace.id} id={workspace.id} index={index} group="workspace">
              <Mark
                workspace={workspace}
                active={workspace.id === props.activeId && !props.settingsOpen}
                current={workspace.id === props.activeId}
                status={workspace.id === props.activeId ? null : loudest(byWorkspace.get(workspace.id) ?? [])}
                keys={jumpKeys(index)}
                onSelect={() => props.onSelect(workspace.id)}
                onMenu={(point) => setMenu({ point, workspace })}
                onRemove={() => props.onRemove(workspace)}
              />
            </SortableItem>
          ))}
        </SortableList>
      </div>
      </RailScroll>

      <RailButton
        icon={PlusIcon}
        label={`Open workspace ${commandKeys("open-workspace")}`}
        dashed
        onClick={props.onCreate}
      />

      <div className="flex-1" />

      <RailButton
        icon={RefreshCwIcon}
        label="Routines"
        active={props.routinesOpen}
        onClick={props.onOpenRoutines}
      />
      <RailButton
        icon={SettingsIcon}
        label={`Settings ${commandKeys("open-settings")}`}
        active={props.settingsOpen}
        onClick={props.onOpenSettings}
      />

      {menu && (
        <ActionMenu
          key={menu.workspace.id}
          point={menu.point}
          title={`${menu.workspace.name} — ${menu.workspace.path}`}
          rename={{
            initial: menu.workspace.name,
            onCommit: (name) => props.onRename(menu.workspace.id, name),
          }}
          actions={[COPY_PATH, SEPARATOR, { ...DELETE, label: "Remove Workspace…" }]}
          onPick={(id) => {
            const workspace = menu.workspace;
            setMenu(null);
            if (id === "copy-path") void navigator.clipboard.writeText(workspace.path);
            if (id === "delete") props.onRemove(workspace);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}

function Mark({
  workspace,
  active,
  current,
  status,
  keys,
  onSelect,
  onMenu,
  onRemove,
}: {
  workspace: Workspace;
  /** On screen: the current workspace with no page over it. */
  active: boolean;
  /** The workspace the tabs belong to, even while settings cover them. */
  current: boolean;
  status: SessionStatus | null;
  keys: string;
  onSelect: () => void;
  onMenu: (point: MenuPoint) => void;
  onRemove: () => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2" || event.key === "ContextMenu") {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu({ x: rect.right + 4, y: rect.top });
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
      data-nav
      data-tauri-drag-region="false"
      aria-current={current ? "true" : undefined}
      aria-label={workspace.name}
      title={`${workspace.name}${keys ? `  ${keys}` : ""}\n${workspace.path}`}
      onClick={onSelect}
      onContextMenu={(event) => onMenu(menuFromEvent(event))}
      onKeyDown={onKeyDown}
      className="group relative grid size-9 place-items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      {/* The pill on the rail's edge: full for the one on screen, a hint on hover. */}
      <span
        aria-hidden
        className={`absolute -left-2 w-[3px] rounded-r-full bg-text transition-[height] duration-150 ${
          active ? "h-6" : current ? "h-2" : "h-0 group-hover:h-3"
        }`}
      />
      <span
        aria-hidden
        className={`grid size-9 place-items-center bg-accent text-[12px] font-semibold tracking-wide text-inverse transition-[border-radius,opacity] duration-150 ${
          current ? "rounded-xl" : "rounded-[18px] opacity-70 group-hover:rounded-xl group-hover:opacity-100"
        }`}
      >
        {workspaceMark(workspace.name)}
      </span>
      {status && (
        <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-sidebar p-0.5">
          <StatusDot status={status} className="size-3" />
        </span>
      )}
    </button>
  );
}

function RailButton({
  icon: Glyph,
  label,
  active = false,
  dashed = false,
  onClick,
}: {
  icon: Icon;
  label: string;
  active?: boolean;
  dashed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-nav
      data-tauri-drag-region="false"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`grid size-9 shrink-0 place-items-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
        dashed
          ? "rounded-[18px] border border-dashed border-border-strong text-text-muted hover:text-text"
          : `rounded-xl ${active ? "bg-selected text-text" : "text-icon hover:bg-hover hover:text-text"}`
      }`}
    >
      <Glyph className="size-[18px]" />
    </button>
  );
}

/**
 * The marks' own scroller: as tall as they are until the rail runs out, then
 * it scrolls. The fade is always on both edges, over a margin of the same
 * height, so at either end it lies over nothing and only shows once a mark
 * slides under it. The active mark is kept in view when a shortcut picks one
 * out of sight.
 */
function RailScroll({ activeId, children }: { activeId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <div
      ref={ref}
      style={{ maskImage: `linear-gradient(to bottom, transparent, #000 ${FADE}px, #000 calc(100% - ${FADE}px), transparent)` }}
      className="no-scrollbar -my-2 flex min-h-0 w-full shrink flex-col items-center overflow-y-auto overscroll-contain py-3 [scroll-padding-block:12px]"
    >
      {children}
    </div>
  );
}

/** The fade's height, and the margin under it at either end of the list. */
const FADE = 12;
