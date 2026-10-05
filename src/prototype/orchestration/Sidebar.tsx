// PROTOTYPE — Crew's session sidebar, copied, with the orchestration changes:
// a bot's children are gone from the list (they live in its chat), and a handoff is a
// top-level session like any of yours. Background work is the chat's business, not the list's.
import { FolderIcon, GitBranchIcon, PlusIcon, RotateCwIcon, SearchIcon, SlidersHorizontalIcon, type LucideIcon as Icon } from "lucide-react";
import { AgentAvatar } from "../../chrome/AgentAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { StatusDot } from "../../chrome/StatusDot";
import { statusLabel } from "../../lib/status";
import { elapsed } from "../../lib/time";
import type { SessionStatus } from "../../lib/types";
import { proto, type ProtoSession, type World } from "./store";

const SURFACE = (active: boolean) => (active ? "bg-selected" : "hover:bg-hover focus-visible:bg-hover");
const FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-border-strong";

export function ProtoSidebar({ world }: { world: World }) {
  const bots = world.sessions.filter((s) => s.kind === "agent");
  // Children are not listed: they are their bot's business, shown in its chat.
  const listed = world.sessions.filter((s) => s.kind !== "agent" && s.owner !== "me");
  const main = listed.filter((s) => !s.worktree);
  const elsewhere = listed.filter((s) => s.worktree);

  return (
    <div data-sidebar-panel className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2" title="/Users/me/Developer/storefront">
        <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">storefront</div>
        <div className="truncate text-[11px] text-text-muted">~/Developer/storefront</div>
      </div>
      <div className="shrink-0 px-2">
        <div className="flex h-8 items-center gap-0.5 pl-2">
          <span className="min-w-0 flex-1 truncate text-text-muted">Worktrees</span>
          <HeaderButton icon={PlusIcon} label="New worktree" />
          <HeaderButton icon={RotateCwIcon} label="Refresh" />
          <HeaderButton icon={SearchIcon} label="Find  /" />
          <HeaderButton icon={SlidersHorizontalIcon} label="View" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <WorktreeHeader label="main" current glyph={FolderIcon} />
        <div className="pb-2 pl-2">
          <div className="grid grid-cols-3 gap-0.5">
            {bots.map((bot) => (
              <Tile key={bot.id} bot={bot} active={bot.id === world.active} />
            ))}
          </div>
          <div className="flex flex-col gap-0.5 pt-0.5">
            {main.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === world.active} />
            ))}
          </div>
        </div>
        {elsewhere.map((s) => (
          <div key={s.id} className="mt-0.5">
            <WorktreeHeader label={s.branch ?? "worktree"} glyph={GitBranchIcon} />
            <div className="pb-2 pl-2">
              <SessionRow session={s} active={s.id === world.active} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeaderButton({ icon: Glyph, label }: { icon: Icon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-6 shrink-0 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <Glyph className="size-4" />
    </button>
  );
}

function WorktreeHeader({ label, current = false, glyph: Glyph }: { label: string; current?: boolean; glyph: Icon }) {
  return (
    <div className="group/tree relative">
      <div className="flex h-8 w-full items-center gap-2 rounded-chrome pr-2 pl-8 text-left">
        <span className={`min-w-0 flex-1 truncate ${current ? "font-semibold text-text" : "text-text/85"}`}>{label}</span>
      </div>
      <span aria-hidden className="pointer-events-none absolute top-1 left-1.5 grid size-6 place-items-center text-icon">
        <Glyph className={`size-4 ${current ? "text-text" : ""}`} />
      </span>
    </div>
  );
}

const BADGE: Partial<Record<SessionStatus, string>> = { "needs-input": "bg-warning", done: "bg-info", error: "bg-danger" };

/** A bot is its face and its name; what its sessions are doing is its chat's business. */
function Tile({ bot, active }: { bot: ProtoSession; active: boolean }) {
  return (
    <button
      type="button"
      data-nav
      data-session
      onClick={() => proto.open(bot.id)}
      title={bot.description || bot.name}
      aria-current={active ? "page" : undefined}
      className={`flex w-full min-w-0 flex-col items-center gap-1 rounded-xl px-1 pt-2 pb-1.5 transition-colors duration-150 ease-out ${SURFACE(active)} ${FOCUS}`}
    >
      <span className="relative">
        <AgentAvatar seed={bot.id} bare animated={bot.status === "working"} className="size-10" />
        <Badge status={bot.status} />
      </span>
      <span className={`w-full truncate text-center text-[12px] ${active ? "font-medium" : ""}`}>{bot.name}</span>
    </button>
  );
}

function Badge({ status }: { status: SessionStatus }) {
  if (status === "idle" || status === "exited") return null;
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      className={`absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-sidebar ${status === "working" ? "opacity-0 motion-reduce:opacity-100" : ""}`}
    >
      {status === "working" || status === "starting" ? (
        <StatusDot status={status} className="size-3" />
      ) : (
        <span className={`size-2.5 rounded-full ${BADGE[status]}`} />
      )}
    </span>
  );
}

function SessionRow({ session, active }: { session: ProtoSession; active: boolean }) {
  return (
    <button
      type="button"
      data-nav
      data-session
      onClick={() => proto.open(session.id)}
      title={session.owner === "user" ? `${session.name}: handed off by ${session.parentName}, yours` : session.name}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left transition-colors duration-150 ease-out ${SURFACE(active)} ${FOCUS}`}
    >
      <ProviderIcon provider={session.provider} className="size-4" />
      <span className={`min-w-0 flex-1 truncate ${active || session.unread ? "font-medium" : ""}`}>{session.name}</span>
      <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{elapsed(session.updatedAt)}</span>
      {session.unread ? <StatusDot status="done" /> : session.status === "working" ? <StatusDot status="working" /> : null}
    </button>
  );
}
