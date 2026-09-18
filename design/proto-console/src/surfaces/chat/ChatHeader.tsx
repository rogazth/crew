import { useRef, useState } from "react";
import { attribution, clock, elapsed, type Letter, type Session } from "@crew/fixtures";
import { Avatar, Badge, Popover, ProviderMark } from "@/ui";
import { store } from "@/lib/store";
import { useMailbox } from "@/lib/roster";
import { shortModel } from "@/lib/format";

/**
 * Chrome, not a log row.
 *
 * "Created by X" arrives from the daemon as a grey system note — the first line
 * of a spawned agent's transcript, indistinguishable from any other note. That
 * is the patch the user complained about. Here it is a fact in the header, with
 * a link to the agent that made this one, and the provider's own warnings stay
 * notes in the log where they belong.
 */
export function ChatHeader({ session }: { session: Session }) {
  const by = attribution(session);
  const queued = useMailbox(session.id);

  return (
    <header className="flex h-[var(--h-tabs)] shrink-0 items-center gap-2 border-b border-rule bg-bg px-3 font-mono text-xs select-none">
      <Avatar seed={session.name} size={16} />
      <span className="shrink-0 text-sm text-ink">{session.name}</span>
      <ProviderMark provider={session.provider} />
      <span className="shrink-0 text-ink-3">{shortModel(session.provider, session.model)}</span>
      {session.autonomy === "full" ? <Badge tone="amber">autonomous</Badge> : null}

      {by ? (
        <span className="flex shrink-0 items-center gap-1 text-ink-4">
          <span aria-hidden>←</span>
          <span>created by</span>
          <button
            type="button"
            onClick={() => store.openSession(by.by.id)}
            className="flex items-center gap-1 text-accent-ink hover:underline"
          >
            <Avatar seed={by.by.name} size={12} />
            {by.by.name}
          </button>
          <span>· {elapsed(by.at)} ago</span>
        </span>
      ) : null}

      <span className="min-w-0 flex-1 truncate pl-1 text-ink-4">{session.description}</span>

      <Mailbox letters={queued} />
      <button
        type="button"
        onClick={() => store.openOverlay({ kind: "sheet", sessionId: session.id })}
        className="shrink-0 text-ink-4 hover:text-ink"
      >
        edit
      </button>
    </header>
  );
}

function Mailbox({ letters }: { letters: Letter[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (letters.length === 0) return null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((held) => !held)}
        title="Letters waiting for this agent"
        className="flex h-4 shrink-0 items-center gap-1 rounded-[var(--r)] border border-amber px-1 text-amber-ink"
      >
        <span>{letters.length}</span>
        <span>queued</span>
      </button>
      <Popover
        open={open}
        anchor={ref.current}
        onClose={() => setOpen(false)}
        align="end"
        label="Mailbox"
        className="w-[380px] py-1"
      >
        <div className="px-2 pt-1 pb-1 font-mono text-xs tracking-wide text-ink-4 uppercase">
          waiting · not delivered yet
        </div>
        {letters.map((letter) => (
          <div key={letter.id} className="flex gap-2 border-t border-rule px-2 py-1.5 first:border-t-0">
            <Avatar seed={letter.from.name} size={16} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    store.openSession(letter.from.id);
                  }}
                  className="font-mono text-xs text-accent-ink hover:underline"
                >
                  {letter.from.name}
                </button>
                <span className="ml-auto font-mono text-xs text-ink-4">{clock(letter.at)}</span>
              </div>
              <p className="text-md text-ink-2">{letter.text}</p>
            </div>
          </div>
        ))}
      </Popover>
    </>
  );
}
