// PROTOTYPE — B · Focus. One context card (repo / worktree), the current worktree's
// crew as big faces, its sessions as rows, and the other worktrees reduced to a
// strip of who is busy there.
import { CaretUpDownIcon, GearIcon, GitBranchIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { StatusDot } from "../../chrome/StatusDot";
import { keysOf } from "./keys";
import { WorkspaceMenu, WorktreeMenu } from "./shell";
import {
  activeTab,
  currentWorktree,
  selectWorkspace,
  selectWorktree,
  sessionsOf,
  workspace,
  worktreesOf,
  worstStatus,
} from "./store";
import {
  ActionRow,
  AddTile,
  AgentTile,
  DiffStat,
  Face,
  Mark,
  SectionHeader,
  SessionRow,
  SidebarToggle,
  TrafficLights,
  useSidebarKeys,
  visibleSessions,
  worktreeKeys,
  type SidebarProps,
} from "./ui";

export function VariantB(p: SidebarProps) {
  const root = useRef<HTMLElement>(null);
  const st = p.st;
  const ws = workspace(st);
  const current = currentWorktree(st);
  const tab = activeTab(st);
  const activeSession = tab?.kind === "session" ? tab.sessionId : null;

  useSidebarKeys(root, {
    toggle: () => {},
    rename: p.askRename,
    remove: p.askRemove,
    search: () => p.setSearching(true),
  });

  const sessions = visibleSessions(p, current);
  const agents = sessions.filter((x) => x.kind === "agent");
  const terminals = sessions.filter((x) => x.kind === "terminal");
  const others = worktreesOf(st, st.activeWorkspace).filter(
    (t) => t.id !== current.id && (p.prefs.scope !== "busy" || sessionsOf(st, t.id).some((x) => x.status !== "idle")),
  );

  return (
    <aside ref={root} data-sidebar-root className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-10 shrink-0 items-center">
        <TrafficLights />
        <SidebarToggle onClick={() => p.run("toggle-sidebar")} />
      </div>

      {/* Where you are, in two lines that are each their own picker. */}
      <div className="shrink-0 px-[11px] pb-3">
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-hairline">
          <WorkspaceMenu
            st={st}
            onSelect={(id) => p.update((s) => selectWorkspace(s, id))}
            onOpen={() => {}}
            className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
          >
            <Mark name={ws.name} className="size-7 rounded-lg text-[11px]" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em]">{ws.name}</span>
            <CaretUpDownIcon className="size-4 shrink-0 text-kumo-subtle" />
          </WorkspaceMenu>
          <div className="mx-2.5 h-px bg-hairline" />
          <WorktreeMenu
            st={st}
            onSelect={(id) => p.update((s) => selectWorktree(s, id))}
            onNew={() => p.run("new-worktree")}
            className="flex h-9 w-full items-center gap-2.5 px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
          >
            <span className="grid size-7 place-items-center">
              <GitBranchIcon className="size-4 text-kumo-subtle" />
            </span>
            <span className="min-w-0 flex-1 truncate">{current.branch}</span>
            {p.prefs.diff && <DiffStat tree={current} />}
            <CaretUpDownIcon className="size-4 shrink-0 text-kumo-subtle" />
          </WorktreeMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[11px]">
        <SectionHeader label="Agents" p={p} />
        <div className="grid grid-cols-2 gap-1 pt-1 pb-3">
          {agents.map((session) => (
            <AgentTile
              key={session.id}
              session={session}
              active={session.id === activeSession}
              names={p.prefs.names}
              size="lg"
              onOpen={() => p.openSession(session.id)}
            />
          ))}
          {!p.query && <AddTile label="New agent" size="lg" onClick={() => p.run("new-agent")} />}
        </div>

        <div className="flex h-8 items-center pl-2 text-kumo-subtle">Sessions</div>
        <div className="flex flex-col gap-0.5 pb-3">
          {terminals.map((session) => (
            <SessionRow key={session.id} session={session} active={session.id === activeSession} onOpen={() => p.openSession(session.id)} />
          ))}
          <ActionRow icon={TerminalWindowIcon} label="New session" keys={keysOf("new-session")} onClick={() => p.run("new-session")} />
        </div>
      </div>

      {/* Other trees stay in sight without taking the list: who is there, and how loud. */}
      {others.length > 0 && p.prefs.scope !== "current" && (
        <div className="shrink-0 border-t border-hairline px-[11px] pt-2 pb-1">
          <div className="flex h-7 items-center pl-2 text-[12px] text-kumo-subtle">Other worktrees</div>
          {others.map((tree) => {
            const index = worktreesOf(st, st.activeWorkspace).findIndex((t) => t.id === tree.id);
            const members = sessionsOf(st, tree.id);
            const faces = members.filter((x) => x.kind === "agent").slice(0, 4);
            return (
              <button
                key={tree.id}
                type="button"
                data-nav
                data-id={tree.id}
                data-kind="worktree"
                onClick={() => p.update((s) => selectWorktree(s, tree.id))}
                className="flex h-8 w-full items-center gap-2 rounded-chrome px-2 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-border-strong"
              >
                <GitBranchIcon className="size-3.5 shrink-0 text-kumo-subtle" />
                <span className="min-w-0 flex-1 truncate">{tree.branch}</span>
                <span className="flex -space-x-1.5">
                  {faces.map((x) => (
                    <Face key={x.id} seed={x.id} className="size-5" />
                  ))}
                </span>
                <StatusDot status={worstStatus(members)} />
                <span className="w-8 text-right text-[11px] text-kumo-subtle">{worktreeKeys(index)}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="shrink-0 px-[11px] py-2">
        <ActionRow icon={GearIcon} label="Settings" keys="⌘," onClick={() => {}} />
      </div>
    </aside>
  );
}
