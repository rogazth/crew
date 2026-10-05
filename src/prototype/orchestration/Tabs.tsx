// PROTOTYPE — Crew's tab strip, copied: same pill, same face ring, plus the
// dashed ring for a turn that ended with work still running in the background.
import { XIcon } from "lucide-react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { TOGGLE_RESERVE } from "../../lib/chrome";
import { toneOf } from "../../lib/tabStyle";
import { proto, type ProtoSession, type World } from "./store";

export function ProtoTabs({ world, inset }: { world: World; inset: boolean }) {
  return (
    <div data-tauri-drag-region className="flex h-10 shrink-0 items-stretch border-b border-border bg-sidebar">
      {inset && <div className={`shrink-0 ${TOGGLE_RESERVE}`} />}
      <div className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5">
        {world.tabs.map((id) => {
          const session = world.sessions.find((s) => s.id === id);
          const chat = world.chats[id];
          // A turn over with commands still running: the tab says how many, without a spinner.
          const background = chat && !chat.working ? chat.tasks.filter((t) => t.state === "running").length : 0;
          return session ? <Pill key={id} session={session} active={id === world.active} background={background} /> : null;
        })}
      </div>
    </div>
  );
}

function Pill({ session, active, background }: { session: ProtoSession; active: boolean; background: number }) {
  const tone = toneOf(session.unread ? "done" : session.status);
  const ring = background > 0 ? "background" : tone.ring;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={() => proto.open(session.id)}
      title={background > 0 ? `${session.name}: ${background} background ${background === 1 ? "command" : "commands"} running` : session.name}
      className={`group relative flex h-7 w-fit max-w-[220px] min-w-[120px] shrink-0 items-center gap-1 rounded-chrome pr-1 pl-2.5 shadow-[0_1px_2px_var(--tab-shadow)] ring-1 outline-none transition-[color,background-color,box-shadow] duration-150 ${
        active ? "bg-canvas text-text ring-hairline [--tab-shadow:var(--color-hairline)]" : "bg-card text-text-muted ring-transparent hover:bg-hover [--tab-shadow:transparent]"
      }`}
    >
      <span className="crew-tab-face size-3.5 shrink-0" data-ring={ring ?? undefined} data-badge={tone.badge ?? undefined}>
        {session.kind === "bot" ? (
          <BotAvatar seed={session.id} bare className="size-3.5" />
        ) : (
          <ProviderIcon provider={session.provider} className="size-3.5" />
        )}
      </span>
      <span className={`min-w-0 flex-1 truncate ${tone.bold ? "font-semibold text-text" : ""}`}>{session.name}</span>
      {background > 0 && <span className="shrink-0 text-[11px] text-warning tabular-nums">{background}</span>}
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            proto.close(session.id);
          }}
          aria-label="Close tab"
          className={`absolute right-0 flex size-5 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-selected hover:text-text ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  );
}
