import clsx from "clsx";
import type { ReactNode } from "react";
import { STUB_LABELS, statusLabel } from "@crew/fixtures";
import { Kbd, StatusMark } from "@/ui";
import { store, useApp } from "@/lib/store";
import { useMailbox } from "@/lib/roster";
import { isLive, source } from "@/lib/source";
import { shortModel } from "@/lib/format";

type Hint = { keys: string; label: string };

/**
 * Permanent chrome. It replaces every scattered hint in the app, so the right
 * side is context-sensitive: what it lists is what the focused surface binds.
 */
export function StatusLine() {
  const state = useApp();
  const tab = state.tabsByWorkspace[state.workspaceId]?.tabs.find(
    (t) => t.id === state.tabsByWorkspace[state.workspaceId]?.activeId,
  );
  const session = tab?.kind === "session" ? state.sessions.find((s) => s.id === tab.sessionId) : undefined;
  const queued = useMailbox(session?.kind === "agent" ? session.id : "");

  let mode = "CHAT";
  let subject = "—";
  let detail: ReactNode = null;
  let hints: Hint[] = [
    { keys: "⏎", label: "send" },
    { keys: "@", label: "file" },
  ];

  if (state.overlay?.kind === "palette") {
    mode = "PALETTE";
    subject = state.overlay.filter;
    hints = [
      { keys: "↑↓", label: "select" },
      { keys: "⏎", label: "open" },
      { keys: "⇥", label: "filter" },
      { keys: "> @ # :", label: "route" },
    ];
  } else if (state.page.kind === "settings") {
    mode = "SETTINGS";
    subject = state.page.section;
    hints = [{ keys: "Esc", label: "close" }];
  } else if (state.page.kind === "routines") {
    mode = "ROUTINES";
    subject = state.page.routineId ?? `${state.routines.length} routines`;
    hints = [{ keys: "Esc", label: "close" }];
  } else if (state.page.kind === "search") {
    mode = "SEARCH";
    subject = state.page.query || "all messages";
    hints = [
      { keys: "⏎", label: "open hit" },
      { keys: "Esc", label: "close" },
    ];
  } else if (tab?.kind === "file") {
    mode = "FILE";
    subject = tab.relative;
    detail = state.dirty[tab.relative] !== undefined ? <span className="text-amber-ink">modified</span> : null;
    hints = [
      { keys: "⌘S", label: "save" },
      { keys: ":", label: "line" },
    ];
  } else if (tab?.kind === "stub") {
    mode = tab.stub === "terminal" ? "TERM" : tab.stub.toUpperCase();
    subject = STUB_LABELS[tab.stub] ?? tab.title;
    hints = [{ keys: "⌘T", label: "new tab" }];
  } else if (session?.kind === "terminal") {
    mode = "TERM";
    subject = session.name;
    hints = [
      { keys: "⌘F", label: "find" },
      { keys: "⌘±", label: "zoom" },
      { keys: "⌘0", label: "reset" },
    ];
  } else if (session) {
    subject = session.id;
    detail = (
      <span className="flex items-center gap-1.5">
        <StatusMark status={session.status} title={false} />
        {statusLabel(session.status).toLowerCase()}
      </span>
    );
  }

  const selection = state.selection.length;

  return (
    <footer className="flex h-[var(--h-status)] shrink-0 items-center gap-0 border-t border-rule bg-raised font-mono text-xs text-ink-3 select-none">
      <Cell className="bg-ink px-2 font-semibold tracking-wide text-on-ink">{mode}</Cell>
      <Cell className="truncate text-ink-2">{subject}</Cell>
      {session?.kind === "agent" ? (
        <Cell>
          {session.provider}/{shortModel(session.provider, session.model)}
        </Cell>
      ) : null}
      {detail ? <Cell>{detail}</Cell> : null}
      {queued.length > 0 ? (
        <Cell className="text-amber-ink">{queued.length} queued</Cell>
      ) : null}
      {selection > 1 ? (
        <Cell className="text-accent-ink">{selection} selected</Cell>
      ) : null}

      <div className="ml-auto flex items-center">
        <SourceBadge connected={state.connected} ready={state.ready} />
        {hints.map((hint) => (
          <Cell key={hint.keys} className="gap-1.5">
            <Kbd>{hint.keys}</Kbd>
            <span>{hint.label}</span>
          </Cell>
        ))}
        <button
          type="button"
          onClick={() => store.openOverlay({ kind: "shortcuts" })}
          className="flex h-[var(--h-status)] items-center gap-1.5 border-l border-rule px-2 hover:text-ink"
        >
          <Kbd>?</Kbd>
          <span>keys</span>
        </button>
      </div>
    </footer>
  );
}

/**
 * Which data the window is looking at. A prototype that can be pointed at a real
 * daemon has to say which one it got, and the status line is where that belongs.
 */
function SourceBadge({ connected, ready }: { connected: boolean | null; ready: boolean }) {
  const label = !ready
    ? "connecting"
    : isLive
      ? `live · ${connected === false ? "reconnecting" : "connected"}`
      : source.label.toLowerCase();
  const tone = !ready
    ? "text-ink-4"
    : isLive && connected === false
      ? "text-amber-ink"
      : isLive
        ? "text-green-ink"
        : "text-ink-3";
  return (
    <Cell className={clsx("gap-1.5", tone)}>
      <span
        aria-hidden
        className={clsx(
          "block size-[6px] rounded-full",
          !ready ? "bg-ink-4" : isLive && connected === false ? "bg-amber" : isLive ? "bg-green" : "bg-ink-4",
        )}
      />
      <span>{label}</span>
    </Cell>
  );
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "flex h-[var(--h-status)] min-w-0 items-center border-r border-rule px-2",
        className,
      )}
    >
      {children}
    </span>
  );
}
