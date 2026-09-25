import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BracketsAngleIcon,
  ClockCounterClockwiseIcon,
  CommandIcon,
  FloppyDiskIcon,
  FolderIcon,
  FolderOpenIcon,
  GearIcon,
  GitBranchIcon,
  KeyboardIcon,
  ListBulletsIcon,
  PlusIcon,
  RobotIcon,
  SidebarSimpleIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { AgentAvatar } from "./AgentAvatar";
import { FileTypeIcon } from "./FileTypeIcon";
import { Kbd } from "./Kbd";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import * as api from "../lib/api";
import { commandKeys, listedCommands, runCommand, type CommandId } from "../lib/commands";
import { fuzzyMatch } from "../lib/fuzzy";
import type { ProjectFile, Session, Workspace, Worktree } from "../lib/types";
import { workspaceMark } from "../lib/workspaces";
import { worktreeLabel, worktreeOf } from "../lib/worktrees";

/** ⌘K agents, worktrees and commands; ⌘P files; ⇧⌘P commands; ⇧⌘O where to work: repo › worktree. */
export type PaletteMode = "all" | "files" | "actions" | "context";

const FILE_LIMIT = 50;

type Item = {
  key: string;
  group: string;
  label: string;
  /** Said before the label, quieter: the worktree of a session, the repo of a worktree. */
  detail?: string | undefined;
  icon: ReactNode;
  trail?: ReactNode;
  /** What the query matches against, when it is more than detail and label. */
  search?: string | undefined;
  run: () => void;
};

type Props = {
  mode: PaletteMode;
  files: ProjectFile[];
  sessions: Session[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  worktrees: Worktree[];
  activeWorktree: string;
  onOpenFile: (file: ProjectFile) => void;
  onOpenSession: (session: Session) => void;
  onSelectWorkspace: (id: string) => void;
  onSelectWorktree: (workspaceId: string, path: string) => void;
  onClose: () => void;
};

const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: "Search agents, worktrees, commands…",
  files: "Open a file…",
  actions: "Run a command…",
  context: "Switch to repo › worktree…",
};

/** One palette with four doors. A leading `>` turns any of them into commands. */
export function CommandPalette(props: Props) {
  const { mode, workspaces, activeWorkspaceId } = props;
  const [raw, setRaw] = useState("");
  const [cursor, setCursor] = useState(0);
  const [others, setOthers] = useState<Record<string, Worktree[]>>({});
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // After commit, not at mount: a terminal that held the keyboard lets go of it by then.
  useEffect(() => search.current?.focus(), []);

  // The other workspaces' worktrees are read when the palette opens; the one on screen is already live.
  useEffect(() => {
    if (mode !== "all" && mode !== "context") return;
    let cancelled = false;
    for (const workspace of workspaces) {
      if (workspace.id === activeWorkspaceId) continue;
      void api
        .listWorktrees(workspace.path)
        .then((trees) => !cancelled && setOthers((prev) => ({ ...prev, [workspace.id]: trees })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, mode, workspaces]);

  const forcedActions = raw.startsWith(">");
  const query = (forcedActions ? raw.slice(1) : raw).trim();
  const shown: PaletteMode = forcedActions ? "actions" : mode;

  const items = useMemo(() => {
    const close = (act: () => void) => () => {
      props.onClose();
      act();
    };
    const active = workspaces.find((w) => w.id === activeWorkspaceId);

    const sessions: Item[] = active
      ? props.sessions.map((session) => {
          const tree = worktreeOf(session, active, props.worktrees);
          return {
            key: `session:${session.id}`,
            group: "Agents & sessions",
            label: session.name,
            detail: tree ? `${worktreeLabel(tree)} ›` : undefined,
            icon:
              session.kind === "agent" ? (
                <AgentAvatar seed={session.id} bare className="size-5" />
              ) : (
                <ProviderIcon provider={session.provider} className="size-4" />
              ),
            trail: <StatusDot status={session.status} />,
            run: close(() => props.onOpenSession(session)),
          } satisfies Item;
        })
      : [];

    const worktrees: Item[] = workspaces.flatMap((workspace) => {
      const trees = workspace.id === activeWorkspaceId ? props.worktrees : (others[workspace.id] ?? []);
      return trees.map((tree, index) => {
        const current = workspace.id === activeWorkspaceId && tree.path === props.activeWorktree;
        const keys = workspace.id === activeWorkspaceId && index < 9 ? commandKeys(`worktree-${index + 1}` as CommandId) : "";
        return {
          key: `worktree:${workspace.id}:${tree.path}`,
          group: "Worktrees",
          label: worktreeLabel(tree),
          detail: `${workspace.name} ›`,
          icon: <GitBranchIcon className="size-4" />,
          trail: <span className="text-[11px] text-kumo-subtle">{current ? "current" : keys}</span>,
          search: `${workspace.name} ${worktreeLabel(tree)}`,
          run: close(() => props.onSelectWorktree(workspace.id, tree.path)),
        } satisfies Item;
      });
    });

    const spaces: Item[] = workspaces.map((workspace, index) => ({
      key: `workspace:${workspace.id}`,
      group: "Workspaces",
      label: workspace.name,
      icon: (
        <span className="grid size-4 place-items-center rounded bg-kumo-brand text-[8px] font-semibold text-kumo-inverse">
          {workspaceMark(workspace.name)}
        </span>
      ),
      trail: (
        <span className="text-[11px] text-kumo-subtle">
          {workspace.id === activeWorkspaceId ? "current" : index < 9 ? commandKeys(`workspace-${index + 1}` as CommandId) : ""}
        </span>
      ),
      run: close(() => props.onSelectWorkspace(workspace.id)),
    }));

    const commands: Item[] = listedCommands().map((command) => {
      const Glyph = ACTION_ICONS[command.id] ?? CommandIcon;
      return {
        key: `command:${command.id}`,
        group: "Commands",
        label: command.label,
        icon: <Glyph className="size-4" />,
        trail: command.keys ? <span className="text-[11px] text-kumo-subtle">{command.keys}</span> : undefined,
        // Closing first lets a command own the surface it opens — a sheet, a dialog, a picker.
        run: close(() => runCommand(command.id)),
      };
    });

    const files: Item[] = props.files.map((file) => ({
      key: `file:${file.path}`,
      group: "Files",
      label: file.relative,
      icon: <FileTypeIcon name={file.name} />,
      run: close(() => props.onOpenFile(file)),
    }));

    if (shown === "files") return rank(files, query).slice(0, FILE_LIMIT);
    if (shown === "actions") return rank(commands, query);
    if (shown === "context") return rank([...worktrees, ...spaces], query);
    // Files have their own door, ⌘P; here they would bury what ⌘K is for.
    return rank([...sessions, ...worktrees, ...spaces, ...commands], query);
  }, [activeWorkspaceId, others, props, query, shown, workspaces]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") return props.onClose();
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      return setCursor((c) => Math.min(c + 1, items.length - 1));
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      return setCursor((c) => Math.max(c - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      items[cursor]?.run();
    }
  }

  // Group headers only while browsing; a search ranks everything as one list.
  const headed = !query && (shown === "all" || shown === "context");

  return (
    <div role="presentation" className="fixed inset-0 z-50" onMouseDown={props.onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="absolute top-[14vh] left-1/2 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl bg-kumo-control text-kumo-default shadow-2xl ring ring-kumo-line"
      >
        <input
          ref={search}
          value={raw}
          placeholder={forcedActions ? PLACEHOLDERS.actions : PLACEHOLDERS[mode]}
          aria-label="Search"
          spellCheck={false}
          onChange={(event) => {
            setRaw(event.target.value);
            setCursor(0);
          }}
          className="h-12 w-full border-b border-kumo-line bg-transparent px-4 text-[14px] outline-none"
        />
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((item, index) => {
            const header = headed && item.group !== items[index - 1]?.group ? item.group : null;
            return (
              <div key={item.key}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] text-kumo-subtle">{header}</div>}
                <button
                  type="button"
                  data-index={index}
                  onMouseMove={() => setCursor(index)}
                  onClick={item.run}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left ${index === cursor ? "bg-hover" : ""}`}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-kumo-subtle">{item.icon}</span>
                  {item.detail && <span className="shrink-0 text-kumo-subtle">{item.detail}</span>}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.trail}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-2.5 py-6 text-center text-placeholder">No matches</p>}
        </div>
        <div className="flex h-9 items-center gap-4 border-t border-kumo-line px-3 text-[11px] text-kumo-subtle">
          <Hint keys="↑↓" label="move" />
          <Hint keys="↵" label="open" />
          <Hint keys="esc" label="close" />
        </div>
      </div>
    </div>
  );
}

const ACTION_ICONS: Partial<Record<CommandId, Icon>> = {
  "open-launcher": PlusIcon,
  "reopen-tab": ArrowCounterClockwiseIcon,
  "open-workspace": FolderOpenIcon,
  "switch-workspace": FolderIcon,
  "toggle-sidebar": SidebarSimpleIcon,
  "new-agent": RobotIcon,
  "new-session": TerminalWindowIcon,
  "new-worktree": GitBranchIcon,
  "next-worktree": GitBranchIcon,
  "prev-worktree": GitBranchIcon,
  "open-settings": GearIcon,
  "save-file": FloppyDiskIcon,
  "toggle-outline": ListBulletsIcon,
  "browser-back": ArrowLeftIcon,
  "browser-forward": ArrowRightIcon,
  "browser-reload": ArrowClockwiseIcon,
  "browser-hard-reload": ArrowClockwiseIcon,
  "browser-devtools": BracketsAngleIcon,
  "open-history": ClockCounterClockwiseIcon,
  shortcuts: KeyboardIcon,
};

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd keys={keys} />
      {label}
    </span>
  );
}

function rank(items: Item[], query: string): Item[] {
  if (!query) return items;
  const scored: { item: Item; score: number }[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(query, item.search ?? `${item.detail ?? ""} ${item.label}`);
    if (hit) scored.push({ item, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}
