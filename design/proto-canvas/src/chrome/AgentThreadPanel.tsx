import { clock, dayLabel } from "@crew/fixtures";
import { threadBetween, useRoster } from "@/lib/agents";
import { cx } from "@/lib/cx";
import { agentTint } from "@/lib/identity";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";

/**
 * The thread drawer. Not a generic collapsible: it holds only the letters
 * between these two agents, in chat form, and it knows which of them are still
 * sitting in a mailbox — a fact the daemon has always had and the app never
 * showed.
 */
export function AgentThreadPanel({ sessionId, peerId }: { sessionId: string; peerId: string }) {
  const { sessions, sessionById, openSession, setDrawer, dark, statusOf } = useStore();
  const roster = useRoster(sessions);
  const thread = threadBetween(roster, sessionId, peerId);

  const me = sessionById(sessionId);
  const peer = sessionById(peerId);
  const peerName = peer?.name ?? peerId;
  const myName = me?.name ?? sessionId;
  const waiting = thread.filter((letter) => letter.state === "waiting").length;

  let lastDay = "";

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-soft)] px-4">
        <span className="flex items-center">
          <Avatar seed={myName} size={28} />
          <span className="-ml-2 rounded-full ring-2 ring-[var(--overlay)]">
            <Avatar seed={peerName} size={28} status={statusOf(peerId)} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">
            {myName} <span className="text-ink-38">·</span> {peerName}
          </p>
          <p className="flex items-center gap-2 text-xs text-ink-52">
            {thread.length} {thread.length === 1 ? "letter" : "letters"}
            {waiting > 0 && <Badge tone="warn">{waiting} waiting</Badge>}
          </p>
        </div>
        <Button
          size="sm"
          variant="default"
          icon="arrowUpRight"
          onClick={() => {
            setDrawer(null);
            openSession(peerId);
          }}
        >
          Open {peerName}
        </Button>
        <button
          type="button"
          onClick={() => setDrawer(null)}
          aria-label="Close"
          className="rise-1 grid size-7 shrink-0 place-items-center rounded-chip text-ink-52 hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="scroller min-h-0 flex-1 px-4 py-4">
        {thread.length === 0 && (
          <p className="py-10 text-center text-base text-ink-38">No letters between these two yet.</p>
        )}
        {thread.map((letter) => {
          const mine = letter.from.id === sessionId;
          const day = dayLabel(letter.at).split(" ")[0] ?? "";
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={letter.id}>
              {showDay && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[var(--line-soft)]" />
                  <span className="text-xs text-ink-38">{day}</span>
                  <span className="h-px flex-1 bg-[var(--line-soft)]" />
                </div>
              )}
              <div className={cx("mb-2.5 flex gap-2", mine ? "flex-row-reverse" : "flex-row")}>
                <Avatar seed={letter.from.name} size={24} className="mt-0.5" />
                <div className={cx("flex min-w-0 max-w-[82%] flex-col", mine ? "items-end" : "items-start")}>
                  <div
                    className={cx(
                      "rounded-card px-3 py-2 text-base el-1",
                      mine ? "bg-accent-soft text-ink" : "bg-raised text-ink",
                      letter.state === "waiting" && "border-dashed opacity-90",
                    )}
                    style={mine ? undefined : { borderLeft: `2px solid ${agentTint(letter.from.name, dark)}` }}
                  >
                    <p className="whitespace-pre-wrap break-words">{letter.text}</p>
                  </div>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-38">
                    {letter.from.name} · {clock(letter.at)}
                    {letter.state === "waiting" && (
                      <span className="flex items-center gap-1 text-[var(--warn)]">
                        <Icon name="clock" size={10} />
                        waiting in the box
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
