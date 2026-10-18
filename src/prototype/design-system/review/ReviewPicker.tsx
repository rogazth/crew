// PROTOTYPE — throwaway. The review picker over the real app, dev builds only:
// one list of every state the redesign has to be looked at in (states.ts), and
// the colourway, theme and simulated update beside it. Picking a state walks
// the app there — workspace, worktree, then the tab, page or dialog — waiting
// for each step to land before the next. ⌃⌥S opens it, ⌃⌥← and ⌃⌥→ step
// through the states in order. Visually apart from the app on purpose.
import {
  ArrowDownToLineIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayersIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../../../lib/api";
import type { EnvLink } from "../../../lib/client/registry";
import type { Process } from "../../../lib/processes";
import type { SettingsSectionId } from "../../../lib/settings";
import { newBrowserTab, newTerminalTab, type Pane } from "../../../lib/tabs";
import type { Session, Tab, Workspace, Worktree } from "../../../lib/types";
import { applyDirection, DIRECTIONS, setTheme, setUpdate, useProto, type Theme, type UpdatePhase } from "../direction";
import { STATES, type ReviewState, type WorkspaceRef } from "./states";

/** What the shell hands the picker: where the app is, and the ways it moves. */
export type ReviewControl = {
  workspaces: Workspace[];
  activeId: string | null;
  remoteOf: (workspace: Workspace) => EnvLink | null;
  /** The active workspace's sessions, children included. */
  sessions: Session[];
  worktrees: Worktree[];
  currentTree: string | null;
  processes: Process[] | null;
  panes: Pane[];
  activate: (id: string) => void;
  selectWorktree: (path: string) => void;
  /** Leaves any page, palette, dialog, sheet or confirm, so each state starts clean. */
  reset: () => void;
  openSession: (session: Session) => void;
  newSession: () => void;
  openTab: (tab: Tab) => void;
  openStub: (stub: "history" | "commands", title: string) => void;
  openFile: (relative: string) => void;
  openProcessRun: (process: Process, worktree: string | null) => void;
  openExplorer: (mode: "files" | "search") => void;
  openSettings: (section: SettingsSectionId) => void;
  addMachine: () => void;
  openRoutines: (sessionId?: string) => void;
  editBot: (session: Session) => void;
  newBot: () => void;
  openPalette: (mode: "all" | "files" | "actions" | "context") => void;
  openDialog: (dialog: "new-worktree" | "shortcuts") => void;
  openMachines: () => void;
  askDelete: (session: Session) => void;
};

const KEY = "crew-proto-review-state";
/** The tab each shell or page state opened, by state id, for this window: going back reuses it. */
const OPENED = new Map<string, string>();
const TIMEOUT = 8000;

const THEMES: { key: Theme; icon: typeof SunIcon; label: string }[] = [
  { key: "system", icon: MonitorIcon, label: "System" },
  { key: "light", icon: SunIcon, label: "Light" },
  { key: "dark", icon: MoonIcon, label: "Dark" },
];
const UPDATES: { key: UpdatePhase; label: string }[] = [
  { key: "none", label: "None" },
  { key: "available", label: "Available" },
  { key: "downloading", label: "Downloading" },
  { key: "ready", label: "Ready" },
];

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Kept for this window only.
  }
}

export function ReviewPicker({ control }: { control: ReviewControl }) {
  const proto = useProto();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(remembered);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** A shell the picker opened, and what to type into it once it is up. */
  const [typing, setTyping] = useState<{ tabId: string; run: string; since: number } | null>(null);

  const index = STATES.findIndex((state) => state.id === currentId);
  const current = index >= 0 ? STATES[index]! : null;

  const go = (state: ReviewState) => {
    setCurrentId(state.id);
    remember(state.id);
    setProblem(null);
    setPending({ state, since: Date.now(), reset: true });
  };
  const step = (by: number) => go(STATES[(Math.max(index, by > 0 ? -1 : 0) + by + STATES.length) % STATES.length]!);

  // The latest of each, for the listeners below that are bound once.
  const latest = useRef(step);
  const latestGo = useRef(go);
  const latestBusy = useRef(false);
  useEffect(() => {
    latest.current = step;
    latestGo.current = go;
    latestBusy.current = pending !== null || typing !== null;
  });
  // For a script that screenshots each state: `crewReview.go(id)`, ids from `crewReview.states`.
  useEffect(() => {
    const review = {
      states: STATES.map(({ id, group, label }) => ({ id, group, label })),
      go: (id: string) => {
        const state = STATES.find((row) => row.id === id);
        if (state) latestGo.current(state);
        return state !== undefined;
      },
      busy: () => latestBusy.current,
    };
    Object.assign(window, { crewReview: review });
  }, []);

  // Toasts land where the bar sits; directions.css lifts them while it shows.
  useEffect(() => {
    if (hidden) return;
    document.documentElement.dataset.reviewBar = "";
    return () => {
      delete document.documentElement.dataset.reviewBar;
    };
  }, [hidden]);

  // Hotkeys by physical key, so ⌥ never turns S into ß.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      if (e.code === "KeyS") setOpen((was) => !was);
      else if (e.code === "ArrowRight") latest.current(1);
      else if (e.code === "ArrowLeft") latest.current(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
      setHidden(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  // Walks toward the pending state one step per render: each step changes
  // what the shell passes in, which runs this again until the state is reached.
  // A step that waits on something loading looks again shortly.
  // The step that acts (opens a tab, resets) runs once per pick: the shell
  // re-renders before the timer below settles it, and must not act again.
  const acted = useRef<{ pending: Pending; outcome: Outcome } | null>(null);
  useEffect(() => {
    if (!pending) return;
    let outcome: Outcome;
    if (acted.current?.pending === pending) outcome = acted.current.outcome;
    else {
      outcome = walk(control, pending, setTyping);
      if (outcome !== "wait" && outcome !== "moved") acted.current = { pending, outcome };
    }
    const settle = () => {
      if (outcome === "done") return setPending(null);
      if (outcome === "reset") return setPending({ ...pending, reset: false });
      if (outcome !== "wait" && outcome !== "moved") {
        setProblem(`${pending.state.label}: ${outcome.problem}`);
        return setPending(null);
      }
      if (Date.now() - pending.since <= TIMEOUT) return setPending({ ...pending });
      setProblem(`${pending.state.label}: ${missing(pending.state)} never showed up. Is this the seeded profile? npm run app:design -- --reseed`);
      setPending(null);
    };
    const later = window.setTimeout(settle, outcome === "wait" || outcome === "moved" ? 200 : 0);
    return () => window.clearTimeout(later);
  }, [control, pending]);

  // Types the command into the shell once its terminal is up; a write before
  // the PTY exists is refused, so it tries again until one lands.
  useEffect(() => {
    if (!typing) return;
    const pane = control.panes.find((row) => row.tab.id === typing.tabId);
    if (!pane) return;
    let stopped = false;
    const attempt = () => {
      if (stopped) return;
      void api
        .writePty(pane.id, `${typing.run}\r`)
        .then(() => setTyping(null))
        .catch(() => {
          if (Date.now() - typing.since > TIMEOUT) setTyping(null);
          else window.setTimeout(attempt, 300);
        });
    };
    const first = window.setTimeout(attempt, 600);
    return () => {
      stopped = true;
      window.clearTimeout(first);
    };
  }, [control.panes, typing]);

  if (!import.meta.env.DEV) return null;

  if (hidden) {
    return (
      <button
        type="button"
        title="Review states (⌃⌥S)"
        onClick={() => setHidden(false)}
        style={{ colorScheme: "dark" }}
        className="fixed right-3 bottom-3 z-[100] grid size-7 place-items-center rounded-full bg-[#111] text-white/70 shadow-xl ring-1 ring-white/10 hover:text-white"
      >
        <LayersIcon className="size-3.5" />
      </button>
    );
  }

  return (
    <div style={{ colorScheme: "dark" }} className="fixed right-3 bottom-3 z-[100] flex flex-col items-end gap-2 text-[12px] text-white">
      {open && (
        <Panel
          currentId={currentId}
          proto={proto}
          onPick={(state) => go(state)}
          onClose={() => setOpen(false)}
        />
      )}
      {problem && (
        <div className="max-w-[340px] rounded-xl bg-[#3a1212] px-3 py-2 text-[11.5px] leading-4 text-red-100 shadow-xl ring-1 ring-red-400/20">{problem}</div>
      )}
      <div className="flex items-center gap-0.5 rounded-full bg-[#111] px-1 py-1 shadow-xl ring-1 ring-white/10">
        <BarButton label="Previous state (⌃⌥←)" onClick={() => step(-1)}>
          <ChevronLeftIcon className="size-4" />
        </BarButton>
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          title="All states (⌃⌥S)"
          className={`flex h-7 max-w-[260px] min-w-[150px] items-center gap-1.5 rounded-full px-2.5 ${open ? "bg-white/20" : "hover:bg-white/10"}`}
        >
          <LayersIcon className="size-3.5 shrink-0 text-white/60" />
          <span className="truncate">
            {current ? (
              <>
                <span className="text-white/50">{current.group} · </span>
                {current.label}
              </>
            ) : (
              "Review states"
            )}
          </span>
          {current && <span className="ml-auto pl-1 text-white/40 tabular-nums">{`${index + 1}/${STATES.length}`}</span>}
        </button>
        <BarButton label="Next state (⌃⌥→)" onClick={() => step(1)}>
          <ChevronRightIcon className="size-4" />
        </BarButton>
        <span className="mx-0.5 h-4 w-px bg-white/15" />
        <BarButton
          label="Hide"
          onClick={() => {
            setOpen(false);
            setHidden(true);
          }}
        >
          <XIcon className="size-3.5" />
        </BarButton>
      </div>
    </div>
  );
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="grid size-7 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
      {children}
    </button>
  );
}

function Panel({
  currentId,
  proto,
  onPick,
  onClose,
}: {
  currentId: string | null;
  proto: ReturnType<typeof useProto>;
  onPick: (state: ReviewState) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(() => Math.max(0, STATES.findIndex((state) => state.id === currentId)));
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return STATES;
    return STATES.filter((state) => {
      const text = `${state.group} ${state.label} ${state.hint}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [query]);
  const at = Math.min(cursor, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-at="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const groups: { group: string; rows: { state: ReviewState; at: number }[] }[] = [];
  shown.forEach((state, i) => {
    const last = groups.at(-1);
    if (last?.group === state.group) last.rows.push({ state, at: i });
    else groups.push({ group: state.group, rows: [{ state, at: i }] });
  });

  return (
    <div className="flex max-h-[min(640px,calc(100vh-80px))] w-[380px] flex-col overflow-hidden rounded-2xl bg-[#111] shadow-2xl ring-1 ring-white/10">
      <div className="flex flex-col gap-2 border-b border-white/10 p-2">
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.06] px-2.5">
          <SearchIcon className="size-3.5 text-white/40" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setCursor(Math.min(at + 1, shown.length - 1));
              else if (e.key === "ArrowUp") setCursor(Math.max(at - 1, 0));
              else if (e.key === "Enter" && shown[at]) onPick(shown[at]);
              else if (e.key === "Escape" && query) setQuery("");
              else if (e.key === "Escape") onClose();
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
            placeholder="Find a state"
            className="h-8 min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/35"
          />
        </div>
        <div className="flex items-center gap-1 px-0.5">
          <Group>
            {DIRECTIONS.map((direction) => (
              <Chip key={direction.key} on={proto.direction === direction.key} onClick={() => applyDirection(direction.key)} title={direction.name}>
                {direction.name}
              </Chip>
            ))}
          </Group>
          <Group>
            {THEMES.map(({ key, icon: Glyph, label }) => (
              <Chip key={key} on={proto.theme === key} onClick={() => setTheme(key)} title={label}>
                <Glyph className="size-3.5" />
              </Chip>
            ))}
          </Group>
          <Group>
            <span title="Simulated app update" className="grid h-6 place-items-center px-1 text-white/45">
              <ArrowDownToLineIcon className="size-3.5" />
            </span>
            <select
              value={proto.update}
              onChange={(e) => setUpdate(e.target.value as UpdatePhase)}
              className="h-6 rounded-md bg-transparent pr-1 text-[11.5px] text-white/80 outline-none"
            >
              {UPDATES.map((update) => (
                <option key={update.key} value={update.key} className="bg-[#111]">
                  {update.key === "downloading" && proto.update === "downloading" ? `${Math.round(proto.progress * 100)}%` : update.label}
                </option>
              ))}
            </select>
          </Group>
        </div>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.map(({ group, rows }) => (
          <div key={group} className="pb-1">
            <div className="px-2 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-white/40 uppercase">{group}</div>
            {rows.map(({ state, at: row }) => (
              <button
                key={state.id}
                type="button"
                data-at={row}
                onMouseMove={() => setCursor(row)}
                onClick={() => onPick(state)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left ${row === at ? "bg-white/10" : ""}`}
              >
                <span className="grid size-4 shrink-0 place-items-center pt-0.5">
                  {state.id === currentId && <CheckIcon className="size-3.5 text-white/80" />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] leading-4 text-white">{state.label}</span>
                  {state.hint && <span className="text-[11.5px] leading-4 text-white/45">{state.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}
        {shown.length === 0 && <div className="px-3 py-6 text-center text-white/40">No state matches</div>}
      </div>
      <div className="flex justify-between border-t border-white/10 px-3 py-1.5 text-[11px] text-white/35">
        <span>↑↓ pick · ↵ go · esc close</span>
        <span>⌃⌥← ⌃⌥→ step</span>
      </div>
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex items-center rounded-lg bg-white/[0.06] p-0.5">{children}</div>;
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`grid h-6 min-w-6 place-items-center rounded-md px-1.5 text-[11.5px] ${on ? "bg-white/20 text-white" : "text-white/55 hover:text-white"}`}
    >
      {children}
    </button>
  );
}

function findWorkspace(control: ReviewControl, ref: WorkspaceRef): Workspace | null {
  if (ref === "home") return control.workspaces.find((workspace) => workspace.home) ?? null;
  return (
    control.workspaces.find((workspace) => {
      if (workspace.home || workspace.name !== ref.name) return false;
      const machine = control.remoteOf(workspace)?.name ?? null;
      return (ref.machine ?? null) === machine;
    }) ?? null
  );
}

/** What the state needs, for the line that says it never came. */
function missing(state: ReviewState): string {
  const target = state.target;
  const where = "ws" in target && target.ws ? describe(target.ws) : "";
  if ("name" in target && target.name) return `${target.name} in ${where}`;
  return where || "it";
}

function describe(ref: WorkspaceRef): string {
  if (ref === "home") return "Home";
  return ref.machine ? `${ref.machine} › ${ref.name}` : ref.name;
}

type Pending = { state: ReviewState; since: number; reset: boolean };
type Outcome = "done" | "reset" | "moved" | "wait" | { problem: string };

/**
 * One step toward `pending`: leave whatever is open, then the workspace, then
 * the worktree, then the thing itself. "moved" and "wait" look again shortly:
 * for the shell to show the move, or for a list that has not loaded yet.
 */
function walk(control: ReviewControl, pending: Pending, type: (typing: { tabId: string; run: string; since: number }) => void): Outcome {
  const target = pending.state.target;
  if (pending.reset) {
    control.reset();
    return "reset";
  }
  if (target.kind === "update") {
    setUpdate(target.phase);
    return "done";
  }
  const ref = "ws" in target ? target.ws : undefined;
  if (ref) {
    const workspace = findWorkspace(control, ref);
    // A remote machine's workspaces show up once it has connected.
    if (!workspace) return "wait";
    if (control.activeId !== workspace.id) {
      control.activate(workspace.id);
      return "moved";
    }
    // A state that names no worktree is the main checkout's, whatever the last one left on screen.
    const named = "tree" in target ? target.tree : undefined;
    const tree = control.worktrees.find((row) => (named && named !== "main" ? row.branch === named : row.main));
    if (named && !tree) return "wait";
    if (tree && control.currentTree !== tree.path) {
      control.selectWorktree(tree.path);
      return "moved";
    }
  }
  const byName = (name: string) => control.sessions.find((row) => row.name === name);
  switch (target.kind) {
    case "workspace":
      return "done";
    case "session": {
      const session = byName(target.name);
      if (!session) return "wait";
      control.openSession(session);
      return "done";
    }
    case "new-session":
      control.newSession();
      return "done";
    case "shell": {
      // The same state again goes back to its shell rather than piling up new ones.
      const kept = control.panes.find((pane) => pane.tab.id === OPENED.get(pending.state.id));
      if (kept) {
        control.openTab(kept.tab);
        return "done";
      }
      const tab = newTerminalTab(control.currentTree === control.worktrees.find((row) => row.main)?.path ? null : control.currentTree);
      control.openTab(tab);
      OPENED.set(pending.state.id, tab.id);
      type({ tabId: tab.id, run: target.run, since: Date.now() });
      return "done";
    }
    case "commands":
      control.openStub("commands", "Commands");
      return "done";
    case "process": {
      const process = control.processes?.find((row) => row.name === target.name);
      if (!process) return "wait";
      control.openProcessRun(process, null);
      return "done";
    }
    case "file":
      control.openFile(target.relative);
      return "done";
    case "browser": {
      const kept = control.panes.find((pane) => pane.tab.id === OPENED.get(pending.state.id));
      const tab = kept?.tab ?? newBrowserTab(target.url);
      control.openTab(tab);
      OPENED.set(pending.state.id, tab.id);
      return "done";
    }
    case "history":
      control.openStub("history", "History");
      return "done";
    case "explorer":
      control.openExplorer(target.mode);
      return "done";
    case "settings":
      control.openSettings(target.section);
      return "done";
    case "add-machine":
      control.addMachine();
      return "done";
    case "routines": {
      if (!target.bot) {
        control.openRoutines();
        return "done";
      }
      const bot = byName(target.bot);
      if (!bot) return "wait";
      control.openRoutines(bot.id);
      return "done";
    }
    case "sheet": {
      if (!target.name) {
        control.newBot();
        return "done";
      }
      const bot = byName(target.name);
      if (!bot) return "wait";
      control.editBot(bot);
      return "done";
    }
    case "palette":
      control.openPalette(target.mode);
      return "done";
    case "dialog":
      control.openDialog(target.dialog);
      return "done";
    case "machines":
      control.openMachines();
      return "done";
    case "confirm": {
      const session = byName(target.name);
      if (!session) return "wait";
      control.askDelete(session);
      return "done";
    }
  }
}
