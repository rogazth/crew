import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { PlusIcon, SettingsIcon, UnplugIcon, type LucideIcon as Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CrewGlyph } from "./CrewGlyph";
import { Tooltip } from "./kit";
import { SortableItem, SortableList } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { RailUpdate } from "./UpdateButton";
import { UsageButton } from "./UsageButton";
import { WorkspacePeek, type WorkspacePeekAnchor } from "./WorkspacePeek";
import { commandKeys, type CommandId } from "../lib/commands";
import { isDeleteChord } from "../lib/hotkey";
import { STATUS_ORDER, statusLabel } from "../lib/status";
import type { Session, SessionStatus, Workspace } from "../lib/types";
import type { EnvLink } from "../lib/client/registry";
import { workspaceMark } from "../lib/workspaces";
import { useWorkspaceFace, useWorkspaceFaces } from "./workspaceProfile";

type Props = {
  /** The projects, home aside. */
  workspaces: Workspace[];
  /** Home, pinned above the projects; null until the daemon has made it. */
  home: Workspace | null;
  activeId: string;
  /** Every workspace's sessions, so a workspace out of sight can still call for attention. */
  sessions: Session[];
  settingsOpen: boolean;
  /** A connector or a CLI's server waits on the person: the gear wears a dot, as Settings' Connectors does. */
  settingsAlert: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** F2 on a mark: the name is renamed where the sidebar shows it. */
  onRequestRename: (id: string) => void;
  onRemove: (workspace: Workspace) => void;
  onReorder: (ids: string[]) => void;
  onOpenSettings: () => void;
  /** Opens Settings on Usage. */
  onOpenUsage: () => void;
  /** The machine a workspace lives on, for the corner badge. Null on this Mac. */
  remoteOf?: (workspace: Workspace) => EnvLink | null;
};

/** The marks slide along the rail only, and never past its ends. */
const RAIL_MODIFIERS = [
  RestrictToVerticalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[data-rail-marks]") ?? null,
  }),
];

/** ⌘1‥9 jump straight to a mark; the hover card teaches the chord. */
function jumpKeys(index: number): string {
  return index < 9 ? commandKeys(`workspace-${index + 1}` as CommandId) : "";
}

const IN_PROGRESS: SessionStatus[] = ["working", "starting"];

/**
 * What a workspace has to say: the loudest status among its sessions, idle and read ones aside.
 * The current workspace shows its sessions itself, so it only reports work still in progress.
 */
function loudest(sessions: Session[], current: boolean): SessionStatus | null {
  for (const status of STATUS_ORDER) {
    if (status === "idle") return null;
    if (current && !IN_PROGRESS.includes(status)) continue;
    if (sessions.some((session) => session.status === status)) return status;
  }
  return null;
}

/**
 * Workspaces as a rail of marks, Slack-style: always in sight, reordered by
 * dragging, switched by ⌘1‥9 or the arrows. Routines and settings sit at its foot.
 */
export function WorkspaceRail(props: Props) {
  useWorkspaceFaces(
    props.workspaces,
    props.workspaces.find((workspace) => workspace.id === props.activeId),
  );
  // A mark held still under the pointer for a beat says which workspace it is and where it lives.
  const [peek, setPeek] = useState<{ id: string; anchor: WorkspacePeekAnchor } | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const onPeek = useCallback((id: string, el: HTMLElement | null) => {
    window.clearTimeout(peekTimer.current);
    if (!el) return setPeek(null);
    peekTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setPeek({ id, anchor: { left: rect.right + 12, top: Math.max(8, Math.min(rect.top - 4, window.innerHeight - 200)) } });
    }, 450);
  }, []);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  const peeked = peek ? props.workspaces.find((workspace) => workspace.id === peek.id) : undefined;
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
      className="flex min-h-0 w-[52px] shrink-0 flex-col items-center gap-2 pt-1 pb-2"
    >
      {props.home && (
        <HomeMark
          active={props.home.id === props.activeId && !props.settingsOpen}
          current={props.home.id === props.activeId}
          status={loudest(byWorkspace.get(props.home.id) ?? [], props.home.id === props.activeId)}
          onSelect={() => props.onSelect(props.home!.id)}
        />
      )}

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
                status={loudest(byWorkspace.get(workspace.id) ?? [], workspace.id === props.activeId)}
                onSelect={() => props.onSelect(workspace.id)}
                onRename={() => {
                  onPeek(workspace.id, null);
                  props.onSelect(workspace.id);
                  props.onRequestRename(workspace.id);
                }}
                onPeek={(el) => onPeek(workspace.id, el)}
                onRemove={() => props.onRemove(workspace)}
                remote={props.remoteOf?.(workspace) ?? null}
              />
            </SortableItem>
          ))}
        </SortableList>
      </div>
      </RailScroll>

      <RailButton
        icon={PlusIcon}
        label="Open workspace"
        keys={commandKeys("open-workspace")}
        dashed
        onClick={props.onCreate}
      />

      <div className="flex-1" />

      <RailUpdate />
      <UsageButton onOpenSettings={props.onOpenUsage} />

      {/* The foot sits under a short rule, apart from the marks. */}
      <span aria-hidden className="h-px w-5 shrink-0 bg-border-strong" />
      <RailButton
        icon={SettingsIcon}
        label="Settings"
        keys={commandKeys("open-settings")}
        active={props.settingsOpen}
        alert={props.settingsAlert}
        onClick={props.onOpenSettings}
      />

      {peek && peeked && (
        <WorkspacePeek
          workspace={peeked}
          sessions={byWorkspace.get(peeked.id) ?? []}
          keys={jumpKeys(props.workspaces.indexOf(peeked))}
          anchor={peek.anchor}
        />
      )}
    </nav>
  );
}

/**
 * Home: the app's own faces instead of initials, and a hairline under it that
 * keeps it out of the projects' order. It is not dragged, renamed or removed.
 */
function HomeMark({
  active,
  current,
  status,
  onSelect,
}: {
  active: boolean;
  current: boolean;
  status: SessionStatus | null;
  onSelect: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-2 pt-1">
      <Tooltip
        content={<RailTip label="Home" keys={commandKeys("go-home")} />}
        side="right"
        delay={0}
        render={
          <button
            type="button"
            data-nav
            data-home-mark
            data-tauri-drag-region="false"
            aria-current={current ? "true" : undefined}
            aria-label="Home"
            onClick={onSelect}
            className="group relative grid size-9 place-items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
          />
        }
      >
        <span
          aria-hidden
          className={`absolute -left-2 w-[3px] rounded-r-full bg-text transition-[height] duration-150 ${
            active ? "h-6" : current ? "h-2" : "h-0 group-hover:h-3"
          }`}
        />
        <span
          aria-hidden
          className={`grid size-9 place-items-center transition-[border-radius,background-color] duration-150 ${
            current ? "rounded-xl bg-card ring-1 ring-border" : "rounded-[18px] group-hover:rounded-xl group-hover:bg-hover"
          }`}
        >
          <CrewGlyph className="size-7" />
        </span>
        {status && (
          <RailStatus status={status} />
        )}
      </Tooltip>
      <span aria-hidden className="h-px w-5 bg-border-strong" />
    </div>
  );
}

function Mark({
  workspace,
  active,
  current,
  status,
  onSelect,
  onRename,
  onRemove,
  onPeek,
  remote,
}: {
  workspace: Workspace;
  /** On screen: the current workspace with no page over it. */
  active: boolean;
  /** The workspace the tabs belong to, even while settings cover them. */
  current: boolean;
  status: SessionStatus | null;
  onSelect: () => void;
  /** F2: the workspace's name, wherever it is changed. */
  onRename: () => void;
  onRemove: () => void;
  /** The mark under the pointer, or null once it leaves or is pressed. */
  onPeek: (el: HTMLElement | null) => void;
  remote: EnvLink | null;
}) {
  const faceUrl = useWorkspaceFace(workspace);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2") {
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
      data-nav
      data-tauri-drag-region="false"
      aria-current={current ? "true" : undefined}
      aria-label={workspace.name}
      onClick={onSelect}
      onMouseEnter={(event) => onPeek(event.currentTarget)}
      onMouseLeave={() => onPeek(null)}
      onPointerDown={() => onPeek(null)}
      // No menu on a mark: the workspace's options are in the sidebar's header.
      onContextMenu={(event) => event.preventDefault()}
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
        className={`grid size-9 place-items-center overflow-hidden text-[12px] font-semibold tracking-wide transition-[border-radius,background-color] duration-150 ${
          faceUrl
            ? current
              ? "rounded-xl"
              : "rounded-[18px] group-hover:rounded-xl"
            : current
              ? "rounded-xl bg-accent text-inverse"
              : "rounded-[18px] bg-fill text-text group-hover:rounded-xl group-hover:bg-selected"
        } ${
          !remote
            ? ""
            : remote.mismatch || remote.status === "offline"
              ? "opacity-35! grayscale"
              : remote.status === "connecting"
                ? "animate-pulse"
                : ""
        }`}
      >
        {faceUrl ? <img src={faceUrl} alt="" draggable={false} className="size-full object-contain" /> : workspaceMark(workspace.name)}
      </span>
      {remote && (
        // Online says nothing: the unplugged badge shows only while the machine is out of
        // reach — the mark itself pulses while it reconnects. It stays in the tree, hidden,
        // so its state can still be read.
        <span
          aria-hidden
          data-remote-badge={remote.mismatch ? "offline" : remote.status}
          className={`absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-fill text-text-muted ring-2 ring-sidebar ${
            remote.status === "online" && !remote.mismatch ? "hidden" : ""
          }`}
        >
          <UnplugIcon className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {status && (
        <RailStatus status={status} />
      )}
    </button>
  );
}

/** A rail button's name to its right, with its chord when it has one: the glyph alone says little. */
function RailTip({ label, keys }: { label: string; keys?: string | undefined }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      {keys && <span className="tracking-wide opacity-60">{keys}</span>}
    </span>
  );
}

function RailButton({
  icon: Glyph,
  label,
  keys,
  active = false,
  dashed = false,
  alert = false,
  onClick,
}: {
  icon: Icon;
  label: string;
  keys?: string;
  active?: boolean;
  dashed?: boolean;
  /** A dot in its corner: something behind it waits on the person. */
  alert?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip
      content={<RailTip label={label} keys={keys} />}
      side="right"
      delay={0}
      render={
        <button
          type="button"
          data-nav
          data-tauri-drag-region="false"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={`relative grid size-9 shrink-0 place-items-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
            dashed
              ? "rounded-[18px] border border-dashed border-border-strong text-text-muted hover:text-text"
              : `rounded-xl ${active ? "bg-selected text-text" : "text-icon hover:bg-hover hover:text-text"}`
          }`}
        />
      }
    >
      <Glyph className="size-[18px]" />
      {alert && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning ring-2 ring-rail" />}
    </Tooltip>
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

/**
 * A mark's status, cut out of its corner. A turn running spins rather than
 * typing: the three dots are wider than the corner has room for.
 */
function RailStatus({ status }: { status: SessionStatus }) {
  return (
    <span className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-sidebar">
      {status === "working" || status === "starting" ? (
        <span
          role="img"
          aria-label={statusLabel(status)}
          title={statusLabel(status)}
          className="size-2 animate-spin rounded-full border-[1.5px] border-text-muted border-t-transparent motion-reduce:animate-none"
        />
      ) : (
        <StatusDot status={status} />
      )}
    </span>
  );
}
