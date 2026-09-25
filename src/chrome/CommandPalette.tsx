import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon, BotIcon, CodeXmlIcon, CommandIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, HistoryIcon, KeyboardIcon, ListIcon, PanelLeftIcon, PlusIcon, RotateCcwIcon, RotateCwIcon, SaveIcon, SearchIcon, SettingsIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { FileTypeIcon } from "./FileTypeIcon";
import { Footer, GroupHeader } from "./kit";
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
  const { workspaces, activeWorkspaceId } = props;
  // Opened through one door, the others stay a click (or ⇥) away.
  const [mode, setMode] = useState<PaletteMode>(props.mode);
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
            detail: tree ? worktreeLabel(tree) : undefined,
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
          detail: workspace.name,
          icon: <GitBranchIcon className="size-4" />,
          trail: current ? <Current /> : keys ? <Kbd keys={keys} /> : undefined,
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
        <span className="grid size-4 place-items-center rounded bg-accent text-[8px] font-semibold text-inverse">
          {workspaceMark(workspace.name)}
        </span>
      ),
      trail:
        workspace.id === activeWorkspaceId ? (
          <Current />
        ) : index < 9 ? (
          <Kbd keys={commandKeys(`workspace-${index + 1}` as CommandId)} />
        ) : undefined,
      run: close(() => props.onSelectWorkspace(workspace.id)),
    }));

    const commands: Item[] = listedCommands().map((command) => {
      const Glyph = ACTION_ICONS[command.id] ?? CommandIcon;
      return {
        key: `command:${command.id}`,
        group: "Commands",
        label: command.label,
        icon: <Glyph className="size-4" />,
        trail: command.keys ? <Kbd keys={command.keys} /> : undefined,
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
    if (event.key === "Tab") {
      event.preventDefault();
      const at = DOORS.findIndex((door) => door.mode === mode);
      const next = DOORS[(at + (event.shiftKey ? DOORS.length - 1 : 1)) % DOORS.length]!;
      setMode(next.mode);
      setRaw("");
      return setCursor(0);
    }
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
      <div className="absolute inset-0 bg-black/15" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="absolute top-[12vh] left-1/2 flex w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-float bg-surface text-text shadow-float"
      >
        <div className="flex h-13 shrink-0 items-center gap-3 px-4">
          <SearchIcon className="size-4.5 shrink-0 text-icon" />
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
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-placeholder"
          />
          <Kbd keys="esc" />
        </div>
        {/* The four doors, so the one you came through is not the only one. */}
        <div role="tablist" className="flex shrink-0 items-center gap-1 border-b border-hairline px-3 pb-2.5">
          {DOORS.map((door) => {
            const on = door.mode === shown;
            return (
              <button
                key={door.mode}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setMode(door.mode);
                  setRaw("");
                  setCursor(0);
                  search.current?.focus();
                }}
                className={`flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors ${
                  on ? "bg-accent text-inverse" : "text-text-muted hover:bg-hover hover:text-text"
                }`}
              >
                {door.label}
                <span className={`text-[10px] ${on ? "opacity-70" : "opacity-60"}`}>{commandKeys(door.command)}</span>
              </button>
            );
          })}
        </div>
        <div ref={list} className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.map((item, index) => {
            const header = headed && item.group !== items[index - 1]?.group ? item.group : null;
            return (
              <div key={item.key}>
                {header && <GroupHeader>{header}</GroupHeader>}
                <button
                  type="button"
                  data-index={index}
                  onMouseMove={() => setCursor(index)}
                  onClick={item.run}
                  className={`flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left ${index === cursor ? "bg-hover" : ""}`}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-icon">{item.icon}</span>
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.detail && (
                    <span className="flex min-w-0 shrink items-center gap-1 text-[12px] text-text-muted">
                      <span className="text-placeholder">in</span>
                      <span className="truncate">{item.detail}</span>
                    </span>
                  )}
                  <span className="flex-1" />
                  {item.trail}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-2.5 py-8 text-center text-placeholder">No matches</p>}
        </div>
        <Footer hints={[["↑↓", "move"], ["↵", "open"], ["⇥", "switch"], [">", "commands"]]} />
      </div>
    </div>
  );
}

const DOORS: { mode: PaletteMode; label: string; command: CommandId }[] = [
  { mode: "all", label: "Everything", command: "open-palette" },
  { mode: "context", label: "Worktrees", command: "switch-workspace" },
  { mode: "files", label: "Files", command: "go-to-file" },
  { mode: "actions", label: "Commands", command: "open-actions" },
];

/** The one on screen says so instead of offering its own key. */
function Current() {
  return <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-text-muted ring-1 ring-hairline">Current</span>;
}

const ACTION_ICONS: Partial<Record<CommandId, Icon>> = {
  "open-launcher": PlusIcon,
  "reopen-tab": RotateCcwIcon,
  "open-workspace": FolderOpenIcon,
  "switch-workspace": FolderIcon,
  "toggle-sidebar": PanelLeftIcon,
  "new-agent": BotIcon,
  "new-session": SquareTerminalIcon,
  "new-worktree": GitBranchIcon,
  "next-worktree": GitBranchIcon,
  "prev-worktree": GitBranchIcon,
  "open-settings": SettingsIcon,
  "save-file": SaveIcon,
  "toggle-outline": ListIcon,
  "browser-back": ArrowLeftIcon,
  "browser-forward": ArrowRightIcon,
  "browser-reload": RotateCwIcon,
  "browser-hard-reload": RotateCwIcon,
  "browser-devtools": CodeXmlIcon,
  "open-history": HistoryIcon,
  shortcuts: KeyboardIcon,
};

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
