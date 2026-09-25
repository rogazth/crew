import { Popover } from "@base-ui/react/popover";
import { BotIcon, GitBranchIcon, GlobeIcon, HistoryIcon, PlusIcon, SquareTerminalIcon } from "lucide-react";
import { Fragment, cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { Footer, GroupHeader } from "./kit";
import { Kbd } from "./Kbd";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import * as api from "../lib/api";
import { launcherAddress, launcherPages } from "../lib/browser/launch";
import { hostOf } from "../lib/browser/history";
import { commandKeys } from "../lib/commands";
import type { ProviderDef, ProviderId } from "../lib/providers";
import { fuzzyMatch } from "../lib/fuzzy";
import type { Session, SessionStatus, StubKind } from "../lib/types";
import { elapsed } from "../lib/time";
import { filterSessions } from "../lib/workspaces";

export type Launch =
  | { kind: "stub"; stub: StubKind; title: string }
  | { kind: "browser"; url?: string }
  | { kind: "new-agent" }
  | { kind: "new-session"; provider?: ProviderId }
  | { kind: "session"; session: Session };

type Action = { id: string; label: string; icon: React.ReactNode; launch: Launch; hint?: string };

type Item = Action & { status?: SessionStatus; meta?: string };
/** `tiles` lay out as the sidebar's agent grid; the rest are rows. */
type Group = { heading?: string; tiles?: boolean; items: Item[] };

const PAGES = 5;

const ICON = "size-4 shrink-0 text-icon";
const TILE_ICON = "size-5 shrink-0 text-icon";

/** The three things a tab can be made from nothing: the grid at the top. */
const CREATE: Action[] = [
  {
    id: "new-agent",
    label: "Agent",
    icon: <BotIcon className={TILE_ICON} />,
    launch: { kind: "new-agent" },
    hint: commandKeys("new-agent"),
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: <SquareTerminalIcon className={TILE_ICON} />,
    launch: { kind: "stub", stub: "terminal", title: "Terminal" },
  },
  {
    id: "browser",
    label: "Browser",
    icon: <GlobeIcon className={TILE_ICON} />,
    launch: { kind: "browser" },
  },
];

/** One row per installed CLI, the ⌘N one first. */
function sessionActions(installed: ProviderDef[], preferred: ProviderId): Action[] {
  const ordered = [...installed].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  return ordered.map((provider) => ({
    id: `new-session:${provider.id}`,
    label: `${provider.label} session`,
    icon: <ProviderIcon provider={provider.id} className="size-4 shrink-0" />,
    launch: { kind: "new-session", provider: provider.id },
    ...(provider.id === preferred ? { hint: commandKeys("new-session") } : {}),
  }));
}

/** Where a session runs, as the sidebar names it: the branch folder, or main. */
function placeOf(session: Session): string {
  return session.worktree ? (session.worktree.split("/").pop() ?? "") : "main";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  onLaunch: (launch: Launch) => void;
};

/** The plus next to the tabs: fixed surfaces on top, the workspace's own agents and sessions below. */
export function TabLauncher({ open, onOpenChange, sessions, onLaunch }: Props) {
  function pick(launch: Launch) {
    onLaunch(launch);
    onOpenChange(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Popover.Trigger
        data-tauri-drag-region="false"
        aria-label={`New tab ${commandKeys("open-launcher")}`}
        title={`New tab ${commandKeys("open-launcher")}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text"
      >
        <PlusIcon className="size-4" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-50">
          <LauncherPopup sessions={sessions} onPick={pick} />
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Mounted only while open, so every open starts from an empty query. */
function LauncherPopup({ sessions, onPick }: { sessions: Session[]; onPick: (launch: Launch) => void }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);

  const [history, setHistory] = useState<{ url: string; title: string }[]>([]);
  const asked = useRef(0);

  const { effective, installed } = useDefaultAgent();
  const typing = query.trim().length > 0;
  const providers = useMemo(() => sessionActions(installed, effective.provider), [installed, effective.provider]);

  // Empty query is the common case: offer what was touched last instead of nothing.
  const matches = useMemo(
    () =>
      typing
        ? filterSessions(sessions, query).slice(0, 8)
        : [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [query, typing, sessions],
  );

  const groups = useMemo((): Group[] => {
    const found = matches.map(
      (session): Item => ({
        id: session.id,
        label: session.name,
        icon:
          session.kind === "agent" ? (
            <AgentAvatar seed={session.id} bare className="size-5" />
          ) : (
            <ProviderIcon provider={session.provider} className="size-4 shrink-0" />
          ),
        launch: { kind: "session", session },
        status: session.status,
        meta: placeOf(session),
        hint: elapsed(session.updatedAt),
      }),
    );
    if (!typing) {
      return [
        { tiles: true, items: CREATE },
        { heading: "New session", items: providers },
        { heading: "Jump back in", items: found },
      ];
    }
    const actions = [...CREATE.map((a) => ({ ...a, label: `New ${a.label}`, icon: smaller(a.icon) })), ...providers].filter(
      (action) => fuzzyMatch(query, action.label),
    );
    const address = launcherAddress(query, actions.length > 0 || matches.length > 0);
    const open: Item | null = address && {
      id: "open-url",
      label: `Open ${address.label}`,
      icon: <GlobeIcon className={ICON} />,
      launch: { kind: "browser", url: address.url },
    };
    const visited = launcherPages(address, history, PAGES).map(
      (page): Item => ({
        id: `page:${page.url}`,
        label: page.title.trim() || page.url,
        icon: <HistoryIcon className={ICON} />,
        launch: { kind: "browser", url: page.url },
        hint: hostOf(page.url),
      }),
    );
    const lead = open && address?.lead ? [open] : [];
    const trailing = open && !address?.lead ? [open] : [];
    return [
      { items: [...lead, ...actions] },
      { heading: "Agents & sessions", items: found },
      { heading: "Pages", items: [...trailing, ...visited] },
    ];
  }, [query, typing, providers, matches, history]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  /** History only answers a query: an empty launcher shows recent sessions, not recent pages. */
  function suggestPages(text: string) {
    const ask = ++asked.current;
    if (!text.trim()) {
      setHistory([]);
      return;
    }
    void api
      .browserHistorySuggest(text, PAGES + 1)
      .then((entries) => {
        // Typing outruns the daemon now and then; only the newest answer counts.
        if (ask === asked.current) setHistory(entries.map((entry) => ({ url: entry.url, title: entry.title })));
      })
      .catch(() => {});
  }

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // The tiles sit in a row: ←→ walk them, ↓ leaves the row for the list.
  const tiles = groups[0]?.tiles ? groups[0].items.length : 0;
  function onKeyDown(event: React.KeyboardEvent) {
    const inTiles = cursor < tiles;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c < tiles ? tiles : c + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (c <= tiles ? 0 : c - 1));
    } else if (inTiles && tiles > 0 && (event.key === "ArrowRight" || event.key === "ArrowLeft") && !query) {
      event.preventDefault();
      setCursor((c) => Math.max(0, Math.min(tiles - 1, c + (event.key === "ArrowRight" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[cursor];
      if (item) onPick(item.launch);
    }
  }

  return (
    <Popover.Popup
      initialFocus={search}
      onKeyDown={onKeyDown}
      className="flex w-[440px] origin-(--transform-origin) flex-col overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        <PlusIcon className="size-4 shrink-0 text-icon" />
        <input
          ref={search}
          value={query}
          placeholder="New tab, or open an agent, session or URL…"
          aria-label="Open a tab"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
            suggestPages(event.target.value);
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-placeholder"
        />
        <Kbd keys={commandKeys("open-launcher")} />
      </div>

      <div ref={list} className="max-h-[420px] overflow-y-auto p-1.5">
        {groups.map((group, g) => {
          const start = groups.slice(0, g).reduce((n, prev) => n + prev.items.length, 0);
          if (group.items.length === 0) return null;
          if (group.tiles) {
            return (
              <div key="tiles" className="grid grid-cols-3 gap-1 p-1 pb-2">
                {group.items.map((item, index) => (
                  <Tile
                    key={item.id}
                    item={item}
                    active={start + index === cursor}
                    onHover={() => setCursor(start + index)}
                    onPick={() => onPick(item.launch)}
                  />
                ))}
              </div>
            );
          }
          return (
            <Fragment key={group.heading ?? "actions"}>
              {group.heading && <GroupHeader>{group.heading}</GroupHeader>}
              {group.items.map((item, index) => (
                <Row
                  key={item.id}
                  item={item}
                  active={start + index === cursor}
                  onHover={() => setCursor(start + index)}
                  onPick={() => onPick(item.launch)}
                />
              ))}
            </Fragment>
          );
        })}

        {items.length === 0 && <p className="px-3 py-6 text-center text-placeholder">No matches</p>}
      </div>
      <Footer hints={[["↑↓", "move"], ["↵", "open"], ["esc", "close"]]} />
    </Popover.Popup>
  );
}

/** A tile's glyph, at a row's size once it is only a search result. */
function smaller(icon: React.ReactNode): React.ReactNode {
  return isValidElement<{ className?: string }>(icon) ? cloneElement(icon, { className: ICON }) : icon;
}

/** The sidebar's agent tile, as a door: glyph over label, lit under the cursor. */
function Tile({ item, active, onHover, onPick }: { item: Item; active: boolean; onHover: () => void; onPick: () => void }) {
  return (
    <button
      type="button"
      data-active={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl ring-1 transition-colors ${
        active ? "bg-hover ring-border" : "ring-hairline"
      }`}
    >
      {item.icon}
      <span className="text-[12px]">{item.label}</span>
    </button>
  );
}

function Row({ item, active, onHover, onPick }: { item: Item; active: boolean; onHover: () => void; onPick: () => void }) {
  return (
    <button
      type="button"
      data-active={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left ${active ? "bg-hover" : ""}`}
    >
      <span className="grid size-5 shrink-0 place-items-center">{item.icon}</span>
      <span className="min-w-0 truncate">{item.label}</span>
      {item.meta && (
        <span className="flex min-w-0 shrink items-center gap-1 text-[12px] text-text-muted">
          <GitBranchIcon className="size-3 shrink-0 text-icon" />
          <span className="truncate">{item.meta}</span>
        </span>
      )}
      <span className="flex-1" />
      {item.status && <StatusDot status={item.status} />}
      {item.hint && <span className="shrink-0 text-[11px] text-text-muted tabular-nums">{item.hint}</span>}
    </button>
  );
}
