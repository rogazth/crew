import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon, BookOpenIcon, BotIcon, CodeXmlIcon, CommandIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, GlobeIcon, HatGlassesIcon, HistoryIcon, KeyboardIcon, ListIcon, PanelLeftIcon, PlayIcon, PlusIcon, RotateCcwIcon, RotateCwIcon, SaveIcon, SearchIcon, LayersIcon, SettingsIcon, SquareIcon, SquareTerminalIcon, TableIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { BotAvatar } from "./BotAvatar";
import { FileTypeIcon } from "./FileTypeIcon";
import { Tabs } from "@base-ui/react/tabs";
import { GroupHeader, IconButton, ListNote, PillTabs } from "./kit";
import { Kbd } from "./Kbd";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { WorkspaceTile } from "./WorkspaceTile";
import * as api from "../lib/api";
import { listedCommands, runCommand, type CommandId } from "../lib/commands";
import { fuzzyMatch } from "../lib/fuzzy";
import { failedUnseen, isOwnedChild, unseen } from "../lib/letters";
import type { SearchHit } from "../lib/protocol";
import { elapsed } from "../lib/time";
import type { ProjectFile, Session, Workspace, Worktree } from "../lib/types";
import { worktreeLabel, worktreeOf } from "../lib/worktrees";
import { scrollShadow } from "../lib/scrollShadow";
import { preloadFileTab } from "../surfaces/load";

/** ⌘K's tabs. One door: a tab is a click or ⇥ away. */
export type PaletteMode = "chats" | "files" | "context" | "actions";

/** What a tab offers before anything is typed: one screen, no scroll. */
const SUGGESTED = 6;
const FILE_LIMIT = 50;
/** Sessions and bots found by name alone; what was said finds more. */
const NAME_LIMIT = 5;
/** Lines shown per conversation; more of one is a search inside it. */
const HITS_PER_SESSION = 3;
const HIT_LIMIT = 300;
/** A pause in typing, not a key: the search waits for it. */
const DEBOUNCE_MS = 250;
/** Blocks read from a session found by name alone, to find the last thing said in it. */
const LAST_PAGE = 8;
/** The roles a reader sees as the conversation; tool output is left out. */
const SAID = new Set(["user", "assistant"]);
/** What a snippet's marks are, from FTS5's snippet(): characters no text can hold. */
const MARK_OPEN = "\u{e000}";
const MARK_CLOSE = "\u{e001}";
const RECENT_COMMANDS_KEY = "palette:recent-commands";
/** Offered while nothing has been run from here yet, and after what has. */
const STARTER_COMMANDS: CommandId[] = ["new-session", "new-bot", "new-worktree", "open-launcher", "open-settings", "shortcuts"];

type Item = {
  key: string;
  group?: string | undefined;
  label: string;
  /** Said after the label, quieter: a session's worktree. */
  detail?: string | undefined;
  icon: ReactNode;
  trail?: ReactNode;
  /** What the query matches against, when it is more than detail and label. */
  search?: string | undefined;
  run: () => void;
};

/** A chat result: the session on the first line, what matched on the second. */
type ChatRow = {
  key: string;
  group?: string | undefined;
  session: Session;
  /** The line the search found; none for a name match or a suggestion. */
  hit?: SearchHit;
  /** Found by name alone: the last thing said in it, for its second line. */
  last?: string;
  run: () => void;
};

type Row = { kind: "item"; item: Item } | { kind: "chat"; row: ChatRow };

type Props = {
  mode: PaletteMode;
  files: ProjectFile[];
  /** The files last on screen, newest first: what Files offers before a query. */
  recentFiles: ProjectFile[];
  /** This workspace's sessions. */
  sessions: Session[];
  /** Every workspace's, for a search that reaches past this one. */
  allSessions: Session[];
  activeSessionId: string | null;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  worktrees: Worktree[];
  onOpenFile: (file: ProjectFile) => void;
  /** Opens a session, in its own workspace, at the line a search found when there is one. */
  onOpenSession: (session: Session, pos: number | null) => void;
  onSelectWorkspace: (id: string) => void;
  onClose: () => void;
};

const PLACEHOLDERS: Record<PaletteMode, string> = {
  chats: "Search chats and bots…",
  files: "Find a file…",
  context: "Switch workspace…",
  actions: "Run a command…",
};

const TABS: { mode: PaletteMode; label: string }[] = [
  { mode: "chats", label: "Chats" },
  { mode: "files", label: "Files" },
  { mode: "context", label: "Workspaces" },
  { mode: "actions", label: "Commands" },
];

/** Waiting on you first: paused, asking, failed, or with news you have not read. */
const needsYou = (s: Session) => Boolean(s.paused) || s.status === "needs-input" || s.status === "error" || failedUnseen(s) || unseen(s);

/** A chat search, answered whole: names, the lines that matched, and the last line of each found by name alone. */
type ChatAnswer = {
  query: string;
  hits: SearchHit[];
  /** Sessions found by name, best first, with the score that ranks them. */
  named: { id: string; score: number }[];
  /** What was last said in each one found only by name, for its second line. */
  last: Map<string, string>;
};

/** The last thing said in a page of a transcript, on one line, its markdown marks dropped. */
function lastSaid(blocks: { role: string; text: string; hidden?: boolean }[]): string {
  const said = [...blocks].reverse().find((block) => SAID.has(block.role) && !block.hidden && block.text.trim());
  return said ? said.text.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

/**
 * The chat search, a pause after the last key: one query per word typed, not per letter. Its answer
 * lands whole, so a result never shows half drawn; until it does, the one before stays on screen.
 */
function useChatSearch(query: string, enabled: boolean, sessions: Session[]): [ChatAnswer | null, () => void] {
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const pool = useRef(sessions);
  useEffect(() => {
    pool.current = sessions;
  }, [sessions]);
  useEffect(() => {
    if (!enabled || !query) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const named = pool.current
          .flatMap((s) => {
            const hit = fuzzyMatch(query, s.name);
            return hit ? [{ id: s.id, score: hit.score }] : [];
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, NAME_LIMIT);
        const hits = await api.searchMessages({ query, sessionIds: [], limit: HIT_LIMIT, sort: "relevance" }).catch(() => []);
        const spoken = new Set(hits.filter((hit) => SAID.has(hit.role)).map((hit) => hit.sessionId));
        const nameOnly = named.filter((entry) => !spoken.has(entry.id));
        const last = new Map(
          await Promise.all(
            nameOnly.map(async ({ id }) => {
              const page = await api.transcriptTail({ sessionId: id, limit: LAST_PAGE }).catch(() => null);
              return [id, page ? lastSaid(page.blocks) : ""] as const;
            }),
          ),
        );
        if (live) setAnswer({ query, hits, named, last });
      })();
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, query]);
  return [answer, () => setAnswer(null)];
}

/** Commands run from here, newest first, kept by crewd. */
function useRecentCommands(): [CommandId[], (id: CommandId) => void] {
  const [recent, setRecent] = useState<CommandId[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .stateGet(RECENT_COMMANDS_KEY)
      .then((raw) => {
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (live && Array.isArray(parsed)) setRecent(parsed.filter((id): id is CommandId => typeof id === "string"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const remember = useCallback(
    (id: CommandId) => {
      const next = [id, ...recent.filter((other) => other !== id)].slice(0, SUGGESTED);
      void api.stateSet(RECENT_COMMANDS_KEY, JSON.stringify(next)).catch(() => {});
    },
    [recent],
  );
  return [recent, remember];
}

/** One palette, four tabs, one door. */
export function CommandPalette(props: Props) {
  const { workspaces, activeWorkspaceId } = props;
  const [mode, setMode] = useState<PaletteMode>(props.mode);
  const [raw, setRaw] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [recentCommands, rememberCommand] = useRecentCommands();

  // After commit, not at mount: a terminal that held the keyboard lets go of it by then.
  useEffect(() => search.current?.focus(), []);
  // A file picked before the window was ever idle: its editor is fetched while the palette is up.
  useEffect(() => void preloadFileTab().catch(() => {}), []);

  const query = raw.trim();
  const shown = mode;
  const [answer, forgetAnswer] = useChatSearch(query, shown === "chats", props.allSessions);
  // Typed into, the list stays as it was until the whole answer is in; emptied, it is the suggestions again.
  const found = query ? answer : null;

  const rows = useMemo<Row[]>(() => {
    const close = (act: () => void) => () => {
      props.onClose();
      act();
    };
    const items = (list: Item[]): Row[] => list.map((item) => ({ kind: "item", item }));
    const here = (s: Session) => (s.workspaceId === activeWorkspaceId ? 0 : 1);

    if (shown === "chats") {
      const chat = (session: Session, group?: string, hit?: SearchHit, last?: string): Row => ({
        kind: "chat",
        row: {
          key: hit ? `hit:${hit.id}` : `session:${session.id}`,
          group,
          session,
          ...(hit ? { hit } : {}),
          ...(last !== undefined ? { last } : {}),
          run: close(() => props.onOpenSession(session, hit ? hit.pos : null)),
        },
      });
      if (!found) {
        const listed = props.sessions.filter((s) => s.id !== props.activeSessionId && !isOwnedChild(s));
        const ranked = [...listed].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.updatedAt - a.updatedAt);
        return ranked.slice(0, SUGGESTED).map((s) => chat(s, "Recent"));
      }
      // One list: a session whose name matches and one where something said does are the same kind of
      // result. Each session once: its matching lines (its name marked too, when it matches), or its name
      // with the last thing said in it.
      const titled = new Map(found.named.map(({ id, score }) => [id, score]));
      const byId = new Map(props.allSessions.map((s) => [s.id, s]));
      const entries = new Map<string, { session: Session; hits: SearchHit[]; order: number }>();
      for (const id of titled.keys()) {
        const session = byId.get(id);
        if (session) entries.set(id, { session, hits: [], order: Number.POSITIVE_INFINITY });
      }
      found.hits.forEach((hit, order) => {
        const session = byId.get(hit.sessionId);
        if (!session || !SAID.has(hit.role)) return;
        const entry = entries.get(session.id) ?? { session, hits: [], order };
        entry.order = Math.min(entry.order, order);
        if (entry.hits.length < HITS_PER_SESSION) entry.hits.push(hit);
        entries.set(session.id, entry);
      });
      const title = (s: Session) => titled.get(s.id) ?? Number.NEGATIVE_INFINITY;
      return [...entries.values()]
        .sort((a, b) => here(a.session) - here(b.session) || title(b.session) - title(a.session) || a.order - b.order)
        .flatMap((entry) =>
          entry.hits.length
            ? entry.hits.map((hit) => chat(entry.session, undefined, hit))
            : [chat(entry.session, undefined, undefined, found.last.get(entry.session.id) ?? "")],
        );
    }

    if (shown === "files") {
      const file = (f: ProjectFile): Item => ({
        key: `file:${f.path}`,
        label: f.relative,
        icon: <FileTypeIcon name={f.name} />,
        run: close(() => props.onOpenFile(f)),
      });
      if (!query) {
        // The ones last on screen, then, to fill the screen, the worktree's shallowest: what sits at its root first.
        const recent = props.recentFiles.slice(0, SUGGESTED);
        const taken = new Set(recent.map((f) => f.path));
        const shallow = props.files
          .filter((f) => !taken.has(f.path))
          .sort((a, b) => depth(a) - depth(b) || a.relative.localeCompare(b.relative))
          .slice(0, SUGGESTED - recent.length);
        return items([...recent.map((f) => ({ ...file(f), group: "Recent" })), ...shallow.map((f) => ({ ...file(f), group: recent.length ? "In this worktree" : undefined }))]);
      }
      return items(rank(props.files.map(file), query).slice(0, FILE_LIMIT));
    }

    if (shown === "context") {
      const spaces: Item[] = workspaces.map((workspace) => ({
        key: `workspace:${workspace.id}`,
        label: workspace.name,
        icon: <WorkspaceTile workspace={workspace} size="sm" />,
        trail: workspace.id === activeWorkspaceId ? <Current /> : undefined,
        run: close(() => props.onSelectWorkspace(workspace.id)),
      }));
      // The one you are in is no suggestion; a search still finds it.
      return items(query ? rank(spaces, query) : spaces.filter((item) => item.key !== `workspace:${activeWorkspaceId}`).slice(0, SUGGESTED));
    }

    const live = listedCommands();
    const commands: Item[] = live.map((command) => {
      const Glyph = ACTION_ICONS[command.id] ?? CommandIcon;
      return {
        key: `command:${command.id}`,
        label: command.label,
        icon: <Glyph className="size-4" />,
        trail: command.keys ? <Kbd keys={command.keys} /> : undefined,
        // Closing first lets a command own the surface it opens — a sheet, a dialog, a picker.
        run: close(() => {
          rememberCommand(command.id);
          runCommand(command.id, "palette");
        }),
      };
    });
    if (query) return items(rank(commands, query));
    const byId = new Map(commands.map((item) => [item.key, item]));
    const suggested = [...new Set([...recentCommands, ...STARTER_COMMANDS])].flatMap((id) => byId.get(`command:${id}`) ?? []);
    return items(suggested.slice(0, SUGGESTED));
  }, [activeWorkspaceId, found, props, query, recentCommands, rememberCommand, shown, workspaces]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  // A list that opens taller than its room fades at the bottom before anyone scrolls it.
  useEffect(() => {
    if (list.current) scrollShadow(list.current);
  }, [rows]);

  function switchTo(next: PaletteMode) {
    setMode(next);
    setRaw("");
    forgetAnswer();
    setCursor(0);
    search.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") return props.onClose();
    if (event.key === "Tab") {
      event.preventDefault();
      const at = TABS.findIndex((tab) => tab.mode === mode);
      return switchTo(TABS[(at + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!.mode);
    }
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      return setCursor((c) => Math.min(c + 1, rows.length - 1));
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      return setCursor((c) => Math.max(c - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[cursor];
      if (row) (row.kind === "chat" ? row.row : row.item).run();
    }
  }

  const groupOf = (row: Row | undefined) => (row ? (row.kind === "chat" ? row.row.group : row.item.group) : undefined);
  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const placeOf = (session: Session): string => {
    if (session.workspaceId === activeWorkspaceId && active) {
      const tree = worktreeOf(session, active, props.worktrees);
      return tree ? worktreeLabel(tree) : "";
    }
    const space = workspaces.find((w) => w.id === session.workspaceId)?.name;
    const tree = session.worktree?.split("/").filter(Boolean).at(-1);
    return [space, tree].filter(Boolean).join(" · ");
  };

  return (
    <div role="presentation" className="fixed inset-0 z-50" onMouseDown={props.onClose}>
      <div className="dialog-backdrop absolute inset-0 bg-(--backdrop)" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="dialog-panel absolute top-[12vh] left-1/2 flex w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-float bg-surface text-text shadow-float"
      >
        <div className="flex h-13 shrink-0 items-center gap-3 pr-2.5 pl-4.5">
          <SearchIcon className="size-4.5 shrink-0 text-icon" />
          <input
            ref={search}
            value={raw}
            placeholder={PLACEHOLDERS[mode]}
            aria-label="Search"
            spellCheck={false}
            onChange={(event) => {
              setRaw(event.target.value);
              setCursor(0);
              // Emptied, the last answer goes: the next word typed starts from the suggestions, not from it.
              if (!event.target.value.trim()) forgetAnswer();
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-placeholder"
          />
          <IconButton icon={XIcon} label="Close" onClick={props.onClose} />
        </div>
        {/* The pills of the pages that split a list (Routines, Services, Settings), and no rule under them. */}
        <Tabs.Root value={shown} onValueChange={(next) => switchTo(next as PaletteMode)} className="shrink-0 px-3.5 pb-1.5">
          <PillTabs value={shown} tabs={TABS.map((tab) => ({ key: tab.mode, label: tab.label }))} />
        </Tabs.Root>
        {/* What scrolls fades at its edges instead of meeting a line. */}
        <div ref={list} onScroll={(event) => scrollShadow(event.currentTarget)} className="crew-scroll-shadow max-h-[56vh] overflow-y-auto px-1.5 pt-1.5 pb-2 [--fade-size:24px]">
          {rows.map((row, index) => {
            const group = groupOf(row);
            const header = group && group !== groupOf(rows[index - 1]) ? group : null;
            const on = index === cursor;
            return (
              <div key={row.kind === "chat" ? row.row.key : row.item.key}>
                {header && <GroupHeader>{header}</GroupHeader>}
                {row.kind === "chat" ? (
                  <ChatResult row={row.row} index={index} on={on} query={found?.query ?? ""} place={placeOf(row.row.session)} onHover={() => setCursor(index)} />
                ) : (
                  <button
                    type="button"
                    data-index={index}
                    onMouseMove={() => setCursor(index)}
                    onClick={row.item.run}
                    className={`flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left ${on ? "bg-hover" : ""}`}
                  >
                    <span className="grid size-5 shrink-0 place-items-center text-icon">{row.item.icon}</span>
                    <span className="min-w-0 truncate">{row.item.label}</span>
                    <span className="flex-1" />
                    {row.item.trail}
                  </button>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <ListNote>{query ? "No matches" : EMPTY[shown]}</ListNote>}
        </div>
      </div>
    </div>
  );
}

const EMPTY: Record<PaletteMode, string> = {
  chats: "No chats yet",
  files: "No files here",
  context: "No other workspaces",
  actions: "Type to find a command",
};

/**
 * A session or bot as one target. Suggested, before a query: one line, its name
 * and where. Found: two, its name and where, then what matched.
 */
function ChatResult({ row, index, on, query, place, onHover }: { row: ChatRow; index: number; on: boolean; query: string; place: string; onHover: () => void }) {
  const { session, hit } = row;
  const glyph = (
    <span className="grid size-5 shrink-0 place-items-center text-icon">
      {session.kind === "bot" ? <BotAvatar seed={session.id} bare className="size-5" /> : <ProviderIcon provider={session.provider} className="size-4" />}
    </span>
  );
  const when = (
    <span className="flex shrink-0 items-center gap-2 text-[11px] text-text-muted tabular-nums">
      {elapsed(hit?.at ?? session.updatedAt)}
      {!hit && <StatusDot status={session.status} />}
    </span>
  );
  if (!query)
    return (
      <button
        type="button"
        data-index={index}
        onMouseMove={onHover}
        onClick={row.run}
        className={`flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left ${on ? "bg-hover" : ""}`}
      >
        {glyph}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate">{session.name}</span>
          {place && <span className="truncate text-[12px] text-text-muted">{place}</span>}
        </span>
        {when}
      </button>
    );
  return (
    <button
      type="button"
      data-index={index}
      onMouseMove={onHover}
      onClick={row.run}
      className={`grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-lg px-2.5 py-2 text-left ${on ? "bg-hover" : ""}`}
    >
      {glyph}
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">
          <NameMarks text={session.name} query={query} />
        </span>
        {place && <span className="truncate text-[12px] text-text-muted">{place}</span>}
      </span>
      {when}
      <span />
      {/* The second line is what was said: the line that matched, or the last one. Never where it lives. */}
      <span className="col-span-2 truncate text-[12.5px] text-text-muted">
        {hit ? <Snippet text={hit.snippet} /> : row.last || <span className="text-placeholder">Nothing said yet</span>}
      </span>
    </button>
  );
}

/** How deep a file sits under its worktree. */
const depth = (file: ProjectFile) => file.relative.split("/").length;

const MARK = "rounded-[3px] bg-find px-px text-text";

/** A line the search found, with what matched marked. */
function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let rest = text.replace(/\s+/g, " ");
  while (rest) {
    const at = rest.indexOf(MARK_OPEN);
    if (at < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, at));
    const end = rest.indexOf(MARK_CLOSE, at);
    parts.push(
      <mark key={parts.length} className={MARK}>
        {rest.slice(at + 1, end < 0 ? undefined : end)}
      </mark>,
    );
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return <>{parts}</>;
}

/** A name with the letters the query matched marked, as a snippet's words are. */
function NameMarks({ text, query }: { text: string; query: string }) {
  const hit = query ? fuzzyMatch(query, text) : null;
  if (!hit || hit.positions.length === 0) return <>{text}</>;
  const marked = new Set(hit.positions);
  const parts: ReactNode[] = [];
  for (let at = 0; at < text.length; ) {
    const on = marked.has(at);
    let end = at;
    while (end < text.length && marked.has(end) === on) end += 1;
    parts.push(
      on ? (
        <mark key={at} className={MARK}>
          {text.slice(at, end)}
        </mark>
      ) : (
        text.slice(at, end)
      ),
    );
    at = end;
  }
  return <>{parts}</>;
}

/** The one on screen says so. */
function Current() {
  return <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-text-muted ring-1 ring-hairline">Current</span>;
}

const ACTION_ICONS: Partial<Record<CommandId, Icon>> = {
  "open-launcher": PlusIcon,
  "reopen-tab": RotateCcwIcon,
  "open-workspace": FolderOpenIcon,
  "switch-workspace": FolderIcon,
  "toggle-sidebar": PanelLeftIcon,
  "new-bot": BotIcon,
  "new-session": SquareTerminalIcon,
  "new-worktree": GitBranchIcon,
  "new-browser-tab": GlobeIcon,
  "new-incognito-tab": HatGlassesIcon,
  "open-settings": SettingsIcon,
  "open-browser-settings": SettingsIcon,
  "save-file": SaveIcon,
  "toggle-outline": ListIcon,
  "toggle-reading": BookOpenIcon,
  "insert-table": TableIcon,
  "browser-back": ArrowLeftIcon,
  "browser-forward": ArrowRightIcon,
  "browser-reload": RotateCwIcon,
  "browser-hard-reload": RotateCwIcon,
  "browser-devtools": CodeXmlIcon,
  "open-history": HistoryIcon,
  "open-commands": LayersIcon,
  "start-all-commands": PlayIcon,
  "stop-all-commands": SquareIcon,
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
