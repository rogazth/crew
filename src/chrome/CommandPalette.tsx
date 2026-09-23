import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwiseIcon,
  CommandIcon,
  FloppyDiskIcon,
  FolderIcon,
  FolderOpenIcon,
  GearIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RobotIcon,
  SidebarSimpleIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { FileTypeIcon } from "./FileTypeIcon";
import { Kbd } from "./Kbd";
import { StatusDot } from "./StatusDot";
import { listedCommands, runCommand, type CommandId } from "../lib/commands";
import {
  PALETTE_MODES,
  groupStarts,
  itemFace,
  paletteActions,
  paletteGroups,
  readQuery,
  stepMode,
  type PaletteItem as Item,
  type PaletteMode,
} from "../lib/palette";
import { moveCursor } from "../lib/picker";
import type { ProjectFile, Session, Workspace } from "../lib/types";

export type { PaletteMode } from "../lib/palette";

type Props = {
  mode: PaletteMode;
  files: ProjectFile[];
  sessions: Session[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onOpenFile: (file: ProjectFile) => void;
  onOpenSession: (session: Session) => void;
  onSelectWorkspace: (id: string) => void;
  onClose: () => void;
};

/**
 * One palette, five filters. ⌘K lands on All, ⌘P on Files, ⇧⌘P on Actions;
 * ⇥ moves between them, and a leading `>` jumps straight to Actions.
 */
export function CommandPalette({
  mode: initialMode,
  files,
  sessions,
  workspaces,
  activeWorkspaceId,
  onOpenFile,
  onOpenSession,
  onSelectWorkspace,
  onClose,
}: Props) {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [raw, setRaw] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { query, shown } = readQuery(raw, mode);

  const actions: Item[] = useMemo(
    () => paletteActions(listedCommands(), workspaces, activeWorkspaceId),
    [activeWorkspaceId, workspaces],
  );

  const groups = useMemo(
    () => paletteGroups({ shown, query, sessions, files, actions }),
    [actions, files, query, sessions, shown],
  );

  const flat = useMemo(() => groups.flatMap((entry) => entry.items), [groups]);
  const starts = useMemo(() => groupStarts(groups), [groups]);

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function pick(item: Item) {
    if (item.kind === "file") {
      onOpenFile(item.file);
      return onClose();
    }
    if (item.kind === "session") {
      onOpenSession(item.session);
      return onClose();
    }
    if (item.kind === "workspace") {
      onSelectWorkspace(item.workspace.id);
      return onClose();
    }
    // Closing first lets a command own the surface it opens — a sheet, a dialog, a picker.
    onClose();
    runCommand(item.id);
  }

  function switchMode(next: PaletteMode) {
    setMode(next);
    setCursor(0);
  }

  function step(delta: number) {
    switchMode(stepMode(mode, delta));
    setRaw((value) => (value.startsWith(">") ? value.slice(1) : value));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") return onClose();
    if (event.key === "Tab") {
      event.preventDefault();
      return step(event.shiftKey ? -1 : 1);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      return setCursor((c) => moveCursor(c, 1, flat.length));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      return setCursor((c) => moveCursor(c, -1, flat.length));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[cursor];
      if (item) pick(item);
    }
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex justify-center bg-black/20 pt-[15vh] backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex h-fit max-h-[60vh] w-[580px] flex-col overflow-hidden rounded-2xl border border-border bg-canvas shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-text-muted" />
          <input
            ref={searchRef}
            value={raw}
            placeholder={PLACEHOLDERS[shown]}
            aria-label="Search"
            spellCheck={false}
            onChange={(event) => {
              setRaw(event.target.value);
              setCursor(0);
            }}
            className="min-w-0 flex-1 bg-transparent py-3.5 outline-none"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-1.5">
          {PALETTE_MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => switchMode(entry.id)}
              className={`rounded-full px-2.5 py-1 transition-colors ${
                entry.id === shown
                  ? "bg-selected text-text"
                  : "text-text-muted hover:bg-hover hover:text-text"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
          {flat.length === 0 && <p className="px-3 py-8 text-center text-placeholder">No matches</p>}
          {groups.map((entry, g) =>
            entry.items.length === 0 ? null : (
              <div key={entry.label}>
                <p className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-text-muted uppercase">
                  {entry.label}
                </p>
                {entry.items.map((item, i) => {
                  const at = starts[g]! + i;
                  return (
                    <Row
                      key={item.key}
                      item={item}
                      active={at === cursor}
                      at={at}
                      onHover={setCursor}
                      onPick={() => pick(item)}
                    />
                  );
                })}
              </div>
            ),
          )}
        </div>

        <div className="flex shrink-0 items-center gap-4 border-t border-border px-3 py-2 text-[11px] text-text-muted">
          <Hint keys="↑↓" label="Select" />
          <Hint keys="⏎" label="Open" />
          <Hint keys="⇥" label="Change filter" />
        </div>
      </div>
    </div>
  );
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: "Search agents, sessions, files and actions…",
  agents: "Search agents…",
  sessions: "Search sessions…",
  files: "Search files by name or path…",
  actions: "Run an action…",
};

const KIND_ICONS: Record<"agents" | "sessions" | "workspace", Icon> = {
  agents: RobotIcon,
  sessions: TerminalWindowIcon,
  workspace: FolderIcon,
};

const ACTION_ICONS: Partial<Record<CommandId, Icon>> = {
  "open-launcher": PlusIcon,
  "reopen-tab": ArrowCounterClockwiseIcon,
  "open-workspace": FolderOpenIcon,
  "switch-workspace": FolderIcon,
  "toggle-sidebar": SidebarSimpleIcon,
  "new-agent": RobotIcon,
  "new-session": TerminalWindowIcon,
  "open-settings": GearIcon,
  "save-file": FloppyDiskIcon,
};

function Row({
  item,
  active,
  at,
  onHover,
  onPick,
}: {
  item: Item;
  active: boolean;
  at: number;
  onHover: (at: number) => void;
  onPick: () => void;
}) {
  const face = describe(item);
  return (
    <button
      type="button"
      data-active={active}
      onMouseEnter={() => onHover(at)}
      onClick={onPick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left ${
        active ? "bg-selected text-text" : "text-text-muted"
      }`}
    >
      {face.icon}
      <span className="shrink-0 truncate text-text">{face.label}</span>
      {face.detail && <span className="min-w-0 truncate text-[12px] opacity-60">{face.detail}</span>}
      <span className="flex-1" />
      {item.kind === "session" && <StatusDot status={item.session.status} />}
      {item.kind === "action" && item.keys && <Kbd keys={item.keys} className="shrink-0" />}
    </button>
  );
}

function describe(item: Item): { icon: React.ReactNode; label: string; detail?: string } {
  const face = itemFace(item);
  if (item.kind === "file") return { icon: <FileTypeIcon name={item.file.name} />, ...face };
  const Glyph =
    item.kind === "session"
      ? KIND_ICONS[item.session.kind === "agent" ? "agents" : "sessions"]
      : item.kind === "workspace"
        ? KIND_ICONS.workspace
        : (ACTION_ICONS[item.id] ?? CommandIcon);
  return { icon: <Glyph className="size-4 shrink-0 text-text-muted" />, ...face };
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd keys={keys} />
      {label}
    </span>
  );
}
