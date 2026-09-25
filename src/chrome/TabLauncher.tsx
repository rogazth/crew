import { Popover } from "@base-ui/react/popover";
import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  GlobeIcon,
  PlusIcon,
  RobotIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { Footer, GroupHeader } from "./kit";
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
import { filterSessions } from "../lib/workspaces";

export type Launch =
  | { kind: "stub"; stub: StubKind; title: string }
  | { kind: "browser"; url?: string }
  | { kind: "new-agent" }
  | { kind: "new-session"; provider?: ProviderId }
  | { kind: "session"; session: Session };

type Action = { id: string; label: string; icon: React.ReactNode; launch: Launch; hint?: string };

type Item = Action & { status?: SessionStatus };
type Group = { heading?: string; items: Item[] };

const PAGES = 5;

const ICON = "size-4 shrink-0 text-kumo-subtle";

const TERMINAL: Action = {
  id: "terminal",
  label: "Terminal",
  icon: <TerminalWindowIcon className={ICON} />,
  launch: { kind: "stub", stub: "terminal", title: "Terminal" },
};

const NEW_AGENT: Action = {
  id: "new-agent",
  label: "New Agent",
  icon: <RobotIcon className={ICON} />,
  launch: { kind: "new-agent" },
  hint: commandKeys("new-agent"),
};

const TRAILING: Action[] = [
  {
    id: "browser",
    label: "Browser",
    icon: <GlobeIcon className={ICON} />,
    launch: { kind: "browser" },
  },
  {
    id: "sidechat",
    label: "New Side Chat",
    icon: <ChatCircleIcon className={ICON} />,
    launch: { kind: "stub", stub: "sidechat", title: "Side Chat" },
  },
];

/** One row per installed CLI, the ⌘N one first. */
function sessionActions(installed: ProviderDef[], preferred: ProviderId): Action[] {
  const ordered = [...installed].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  return ordered.map((provider) => ({
    id: `new-session:${provider.id}`,
    label: `New ${provider.label} Session`,
    icon: <ProviderIcon provider={provider.id} className="size-4 shrink-0" />,
    launch: { kind: "new-session", provider: provider.id },
    ...(provider.id === preferred ? { hint: commandKeys("new-session") } : {}),
  }));
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
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text"
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
  const actions = useMemo(() => {
    const all = [TERMINAL, NEW_AGENT, ...sessionActions(installed, effective.provider), ...TRAILING];
    if (!query.trim()) return all;
    return all.filter((action) => fuzzyMatch(query, action.label));
  }, [query, installed, effective.provider]);

  // Empty query is the common case: offer what was touched last instead of nothing.
  const matches = useMemo(
    () =>
      query.trim()
        ? filterSessions(sessions, query).slice(0, 8)
        : [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [query, sessions],
  );

  const groups = useMemo((): Group[] => {
    const address = launcherAddress(query, actions.length > 0 || matches.length > 0);
    const open: Item | null = address && {
      id: "open-url",
      label: `Open ${address.label}`,
      icon: <GlobeIcon className={ICON} />,
      launch: { kind: "browser", url: address.url },
    };
    const pages = query.trim() ? launcherPages(address, history, PAGES) : [];
    const visited = pages.map(
      (page): Item => ({
        id: `page:${page.url}`,
        label: page.title.trim() || page.url,
        icon: <ClockCounterClockwiseIcon className={ICON} />,
        launch: { kind: "browser", url: page.url },
        hint: hostOf(page.url),
      }),
    );
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
        hint: session.kind === "agent" ? "Agent" : "Session",
      }),
    );
    const lead = open && address?.lead ? [open] : [];
    const trailing = open && !address?.lead ? [open] : [];
    return [
      { items: [...lead, ...actions] },
      { heading: query.trim() ? "Open" : "Recent", items: found },
      { heading: "Pages", items: [...trailing, ...visited] },
    ];
  }, [query, actions, matches, history]);

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

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[cursor];
      if (item) onPick(item.launch);
    }
  }

  return (
    <Popover.Popup
      initialFocus={search}
      onKeyDown={onKeyDown}
      className="w-[420px] origin-(--transform-origin) overflow-hidden rounded-xl bg-kumo-control text-kumo-default shadow-2xl ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0"
    >
      <input
        ref={search}
        value={query}
        placeholder="Open an agent, a session, a URL…"
        aria-label="Open a tab"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
          suggestPages(event.target.value);
        }}
        className="h-11 w-full border-b border-kumo-line bg-transparent px-4 text-[14px] outline-none"
      />

      <div ref={list} className="max-h-80 overflow-y-auto p-1.5">
        {groups.map((group, g) => {
          const start = groups.slice(0, g).reduce((n, prev) => n + prev.items.length, 0);
          return (
            <Fragment key={group.heading ?? "actions"}>
              {group.heading && group.items.length > 0 && <GroupHeader>{group.heading}</GroupHeader>}
              {group.items.map((item, index) => (
                <Row
                  key={item.id}
                  active={start + index === cursor}
                  onHover={() => setCursor(start + index)}
                  onPick={() => onPick(item.launch)}
                  icon={item.icon}
                  label={item.label}
                  status={item.status}
                  hint={item.hint}
                />
              ))}
            </Fragment>
          );
        })}

        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-placeholder">No matches</p>
        )}
      </div>
      <Footer hints={[["↑↓", "move"], ["↵", "open"], ["esc", "close"]]} />
    </Popover.Popup>
  );
}

function Row({
  active,
  onHover,
  onPick,
  icon,
  label,
  status,
  hint,
}: {
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  icon: React.ReactNode;
  label: string;
  status?: SessionStatus | undefined;
  hint?: string | undefined;
}) {
  return (
    <button
      type="button"
      data-active={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left ${active ? "bg-hover" : ""}`}
    >
      <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {status && <StatusDot status={status} />}
      {hint && <span className="shrink-0 text-[11px] text-kumo-subtle">{hint}</span>}
    </button>
  );
}
