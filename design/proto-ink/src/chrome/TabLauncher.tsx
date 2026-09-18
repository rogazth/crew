import { useMemo, useState } from "react";
import { STUB_KINDS, STUB_LABELS, commandKeys, elapsed } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";
import { useApp } from "@/lib/store";
import { Avatar, IconButton, Popover, StatusDot, Tooltip } from "@/ui";

const STUB_ICON: Record<string, IconName> = {
  terminal: "terminal",
  browser: "globe",
  sidechat: "message",
};

export function TabLauncher() {
  const { sessions, activeWorkspaceId, tabs, launcher, actions } = useApp();
  const [query, setQuery] = useState("");

  const candidates = useMemo(() => {
    const open = new Set(
      tabs.tabs.flatMap((tab) => (tab.kind === "session" ? [tab.sessionId] : [])),
    );
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((s) => s.workspaceId === activeWorkspaceId && !open.has(s.id))
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [sessions, activeWorkspaceId, tabs.tabs, query]);

  return (
    <Popover
      open={launcher}
      onOpenChange={(next) => {
        actions.setLauncher(next);
        if (!next) setQuery("");
      }}
      align="end"
      sideOffset={4}
      width={296}
      trigger={
        <span>
          <Tooltip content={`New tab ${commandKeys("open-launcher")}`}>
            <IconButton icon="plus" label="New tab" size="sm" />
          </Tooltip>
        </span>
      }
    >
      <div className="flex flex-col p-1">
        <div className="flex h-7 items-center gap-1.5 rounded-md px-2">
          <Icon name="search" size={14} className="shrink-0 text-icon-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Open a session…"
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-quaternary"
          />
        </div>
        <div className="my-1 h-px bg-[var(--stroke-tertiary)]" />
        <LauncherRow
          icon="bot"
          label="New agent"
          hint={commandKeys("new-agent")}
          onClick={() => {
            actions.setLauncher(false);
            actions.openSheet(null);
          }}
        />
        <LauncherRow
          icon="terminal"
          label="New session"
          hint={commandKeys("new-session")}
          onClick={() => {
            actions.setLauncher(false);
            actions.createSession({
              name: `shell ${Math.floor(Math.random() * 90 + 10)}`,
              kind: "terminal",
              model: "",
            });
          }}
        />
        <div className="my-1 h-px bg-[var(--stroke-tertiary)]" />
        <p className="px-2 pb-1 text-micro uppercase tracking-[0.06em] text-quaternary">Panes</p>
        {STUB_KINDS.map((stub) => (
          <LauncherRow
            key={stub}
            icon={STUB_ICON[stub] ?? "square"}
            label={STUB_LABELS[stub] ?? stub}
            onClick={() => {
              actions.setLauncher(false);
              actions.openStub(stub, STUB_LABELS[stub] ?? stub);
            }}
          />
        ))}
        {candidates.length > 0 && (
          <>
            <div className="my-1 h-px bg-[var(--stroke-tertiary)]" />
            <p className="px-2 pb-1 text-micro uppercase tracking-[0.06em] text-quaternary">
              Sessions
            </p>
            {candidates.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  actions.setLauncher(false);
                  actions.openSession(session.id);
                }}
                className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-body text-secondary transition-colors hover:bg-[var(--fill-tertiary)] hover:text-primary"
              >
                <Avatar
                  seed={session.name}
                  size={16}
                  kind={session.kind === "terminal" ? "terminal" : "agent"}
                />
                <span className="min-w-0 flex-1 truncate">{session.name}</span>
                <span className="shrink-0 text-micro text-quaternary tnum">
                  {elapsed(session.updatedAt)}
                </span>
                <StatusDot status={session.status} />
              </button>
            ))}
          </>
        )}
      </div>
    </Popover>
  );
}

function LauncherRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex h-7 items-center gap-2 rounded-md px-2 text-left text-body text-secondary",
        "transition-colors hover:bg-[var(--fill-tertiary)] hover:text-primary",
      )}
    >
      <Icon name={icon} size={14} className="shrink-0 text-icon-faint" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-micro text-quaternary">{hint}</span>}
    </button>
  );
}
