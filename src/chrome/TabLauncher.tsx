import { Popover } from "@base-ui/react/popover";
import {
  ChatCircleIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RobotIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { commandKeys } from "../lib/commands";
import { fuzzyMatch } from "../lib/fuzzy";
import type { Session, SessionStatus, StubKind } from "../lib/types";
import { filterSessions } from "../lib/workspaces";

export type Launch =
  | { kind: "stub"; stub: StubKind; title: string }
  | { kind: "new-agent" }
  | { kind: "new-session" }
  | { kind: "session"; session: Session };

type Action = { id: string; label: string; icon: Icon; launch: Launch };

const ACTIONS: Action[] = [
  {
    id: "terminal",
    label: "Terminal",
    icon: TerminalWindowIcon,
    launch: { kind: "stub", stub: "terminal", title: "Terminal" },
  },
  { id: "new-agent", label: "New Agent", icon: RobotIcon, launch: { kind: "new-agent" } },
  {
    id: "new-session",
    label: "New Session",
    icon: PlusIcon,
    launch: { kind: "new-session" },
  },
  {
    id: "browser",
    label: "Browser",
    icon: GlobeIcon,
    launch: { kind: "stub", stub: "browser", title: "Browser" },
  },
  {
    id: "sidechat",
    label: "New Side Chat",
    icon: ChatCircleIcon,
    launch: { kind: "stub", stub: "sidechat", title: "Side Chat" },
  },
];

const KEYS: Record<string, string> = {
  "new-agent": commandKeys("new-agent"),
  "new-session": commandKeys("new-session"),
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  onLaunch: (launch: Launch) => void;
};

/** The plus next to the tabs: fixed surfaces on top, the workspace's own agents and sessions below. */
export function TabLauncher({ open, onOpenChange, sessions, onLaunch }: Props) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);

  const actions = useMemo(() => {
    if (!query.trim()) return ACTIONS;
    return ACTIONS.filter((action) => fuzzyMatch(query, action.label));
  }, [query]);

  // Empty query is the common case: offer what was touched last instead of nothing.
  const matches = useMemo(
    () =>
      query.trim()
        ? filterSessions(sessions, query).slice(0, 8)
        : [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [query, sessions],
  );
  const heading = query.trim() ? "Open" : "Recent";

  const items: Launch[] = useMemo(
    () => [
      ...actions.map((action) => action.launch),
      ...matches.map((session): Launch => ({ kind: "session", session })),
    ],
    [actions, matches],
  );

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (open) return;
    setQuery("");
    setCursor(0);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function pick(launch: Launch) {
    onLaunch(launch);
    onOpenChange(false);
  }

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
      if (item) pick(item);
    }
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
          <Popover.Popup
            onKeyDown={onKeyDown}
            className="w-[380px] origin-(--transform-origin) overflow-hidden rounded-xl bg-kumo-control text-kumo-default shadow-xl ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            <div className="flex items-center gap-2 border-b border-kumo-line px-3">
              <MagnifyingGlassIcon className="size-4 shrink-0 text-kumo-subtle" />
              <input
                autoFocus
                value={query}
                placeholder="Open an agent, a session, …"
                aria-label="Open a tab"
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent py-3 outline-none"
              />
            </div>

            <div ref={list} className="max-h-80 overflow-y-auto p-1">
              {actions.map((action, index) => (
                <Row
                  key={action.id}
                  active={index === cursor}
                  onHover={() => setCursor(index)}
                  onPick={() => pick(action.launch)}
                  icon={<action.icon className="size-4 shrink-0 text-kumo-subtle" />}
                  label={action.label}
                  hint={KEYS[action.id]}
                />
              ))}

              {matches.length > 0 && (
                <p className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-kumo-subtle uppercase">
                  {heading}
                </p>
              )}
              {matches.map((session, index) => {
                const at = actions.length + index;
                return (
                  <Row
                    key={session.id}
                    active={at === cursor}
                    onHover={() => setCursor(at)}
                    onPick={() => pick({ kind: "session", session })}
                    icon={
                      session.kind === "agent" ? (
                        <RobotIcon className="size-4 shrink-0 text-kumo-subtle" />
                      ) : (
                        <ProviderIcon provider={session.provider} className="size-4 shrink-0" />
                      )
                    }
                    label={session.name}
                    status={session.status}
                    hint={session.kind === "agent" ? "Agent" : "Session"}
                  />
                );
              })}

              {items.length === 0 && (
                <p className="px-3 py-6 text-center text-placeholder">No matches</p>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
        active ? "bg-hover text-kumo-default" : "text-kumo-default"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {status && <StatusDot status={status} />}
      {hint && <span className="shrink-0 text-[11px] text-kumo-subtle">{hint}</span>}
    </button>
  );
}
