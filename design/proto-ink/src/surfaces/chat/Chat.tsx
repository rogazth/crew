import { useEffect, useState } from "react";
import { attribution, clock, dayLabel, elapsed, providerLine, statusLabel } from "@crew/fixtures";
import type { Letter, Session } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { mailboxOf, useLetterIndex, useThread } from "@/lib/chat";
import { useApp } from "@/lib/store";
import { Avatar, IconButton, Menu, MenuItem, MenuSeparator, StatusDot, Tooltip } from "@/ui";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

export function Chat({ session }: { session: Session }) {
  const { actions, sessions } = useApp();
  const { blocks, working, status, runtime } = useThread(session.id);
  const index = useLetterIndex(sessions);
  const waiting = mailboxOf(index, session.id);

  // The runtime owns the live status; the sidebar and the tab strip read the store.
  useEffect(() => {
    if (status !== session.status) actions.setStatus(session.id, status);
  }, [status, session.status, session.id, actions]);

  const empty = blocks.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3">
        <Avatar seed={session.name} size={16} />
        <span className="text-body text-primary">{session.name}</span>
        <StatusDot status={status} />
        <span className="text-micro text-quaternary">{statusLabel(status)}</span>
        <span className="text-micro text-quaternary">·</span>
        <span className="truncate text-micro text-quaternary">
          {providerLine(session.provider, session.model)}
        </span>
        <span className="flex-1" />
        <span className="text-micro text-quaternary tnum">{elapsed(session.updatedAt)}</span>
        <Tooltip content="Search this conversation">
          <IconButton
            icon="search"
            size="sm"
            label="Search this conversation"
            onClick={() => actions.openSearch(session.name)}
          />
        </Tooltip>
        <Menu
          align="end"
          trigger={
            <span>
              <IconButton icon="ellipsis" size="sm" label="Session menu" />
            </span>
          }
        >
          <MenuItem icon="edit" onClick={() => actions.openSheet(session.id)}>
            Edit agent…
          </MenuItem>
          <MenuItem icon="routine" onClick={() => actions.openRoutines(null)}>
            Routines…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="stop" disabled={!working} onClick={() => runtime.stop()}>
            Stop the turn
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="trash"
            destructive
            onClick={() =>
              actions.confirm({
                title: `Delete ${session.name}?`,
                description: "Its transcript goes with it. This cannot be undone.",
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: () => actions.deleteSessions([session.id]),
              })
            }
          >
            Delete agent
          </MenuItem>
        </Menu>
      </header>

      <Attribution session={session} />

      {empty ? (
        // An empty chat has nothing to sit under, so the composer takes the page.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <Avatar seed={session.name} size={44} />
            <h1 className="text-title text-primary">{session.name}</h1>
            <p className="max-w-80 text-body text-tertiary">
              {session.description || "No description yet. Give it one so the others know what it owns."}
            </p>
          </div>
          <Composer
            session={session}
            working={working}
            centred
            onSend={(text, files) => runtime.send(text, files)}
            onStop={() => runtime.stop()}
          />
          <p className="text-micro text-quaternary">
            Mention a file with <span className="font-mono">@</span> · ⏎ sends
          </p>
        </div>
      ) : (
        <>
          <Transcript session={session} blocks={blocks} working={working} />
          <div className="flex shrink-0 flex-col gap-1.5 px-6 pb-4">
            <Mailbox letters={waiting} session={session} />
            <Composer
              session={session}
              working={working}
              centred={false}
              onSend={(text, files) => runtime.send(text, files)}
              onStop={() => runtime.stop()}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The daemon writes "Created by lead" into the child's transcript as an ordinary
 * system note — a grey line of prose, and the first thing anyone sees when they
 * open a spawned agent. It is a fact about the agent, not a thing that happened
 * in the conversation, so it belongs in the chrome.
 */
function Attribution({ session }: { session: Session }) {
  const { actions } = useApp();
  const made = attribution(session);
  if (!made) return null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--stroke-tertiary)] bg-chrome px-3">
      <Icon name="bot" size={12} className="shrink-0 text-icon-faint" />
      <span className="text-micro text-tertiary">Created by</span>
      <button
        type="button"
        onClick={() => actions.openSession(made.by.id)}
        className="flex items-center gap-1 rounded-sm px-0.5 text-micro text-secondary transition-colors hover:text-primary"
      >
        <Avatar seed={made.by.name} size={13} />
        <span className="underline decoration-[var(--stroke-secondary)] underline-offset-2">
          {made.by.name}
        </span>
      </button>
      <span className="text-micro text-quaternary">·</span>
      <time className="text-micro text-quaternary tnum">{dayLabel(made.at)}</time>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => actions.openSession(made.by.id)}
        className="flex items-center gap-1 text-micro text-quaternary transition-colors hover:text-secondary"
      >
        Open {made.by.name}
        <Icon name="external" size={11} />
      </button>
    </div>
  );
}

/**
 * Letters the daemon has queued for this agent because it was mid-turn. The
 * store has always tracked them and the window has never shown them, which is
 * how "I wrote to it and nothing happened" becomes a mystery.
 */
function Mailbox({ letters, session }: { letters: Letter[]; session: Session }) {
  const { actions } = useApp();
  const [open, setOpen] = useState(false);
  if (letters.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[46rem] overflow-hidden rounded-card bg-chrome hairline">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-[var(--fill-quaternary)]"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-[var(--status-attention)]">
          <Icon name="inbox" size={14} />
        </span>
        <span className="text-body text-primary">
          {letters.length === 1 ? "1 letter waiting" : `${letters.length} letters waiting`}
        </span>
        <span className="min-w-0 truncate text-micro text-tertiary">
          delivered to {session.name} when this turn ends
        </span>
        <span className="flex-1" />
        <span className="flex shrink-0 -space-x-1">
          {letters.slice(0, 3).map((letter) => (
            <Avatar
              key={letter.id}
              seed={letter.from.name}
              size={14}
              className="ring-1 ring-[var(--surface-chrome)]"
            />
          ))}
        </span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={13}
          className="shrink-0 text-icon-faint"
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-[var(--stroke-tertiary)] px-3 py-2.5">
          {letters.map((letter) => (
            <div key={letter.id} className="flex gap-2">
              <Avatar seed={letter.from.name} size={18} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <button
                    type="button"
                    onClick={() => actions.openSession(letter.from.id)}
                    className="text-small text-secondary transition-colors hover:text-primary"
                  >
                    {letter.from.name}
                  </button>
                  <time className="text-micro text-quaternary tnum">{clock(letter.at)}</time>
                </span>
                <p className={cx("whitespace-pre-wrap text-body text-tertiary")}>{letter.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
