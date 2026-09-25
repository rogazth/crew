// PROTOTYPE — C · Rail. Workspaces become a rail of marks (Slack/Discord), so the
// selector has a shape by being always there. The panel is the repo: worktrees
// as an accordion where only the one you are in opens by default.
import { GearIcon, GitBranchIcon, PlusIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { StatusDot } from "../../chrome/StatusDot";
import { keysOf } from "./keys";
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
  visibleWorktrees,
  workspaceKeys,
  worktreeKeys,
  type SidebarProps,
} from "./ui";

export function VariantC(p: SidebarProps) {
  const root = useRef<HTMLElement>(null);
  const [extra, setExtra] = useState<Set<string>>(new Set());
  const st = p.st;
  const ws = workspace(st);
  const current = currentWorktree(st);
  const tab = activeTab(st);
  const activeSession = tab?.kind === "session" ? tab.sessionId : null;

  const setOpen = (id: string, open: boolean) =>
    setExtra((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  useSidebarKeys(root, {
    toggle: (id, open) => (id === current.id ? undefined : setOpen(id, open)),
    rename: p.askRename,
    remove: p.askRemove,
    search: () => p.setSearching(true),
  });

  const trees = visibleWorktrees(p);

  return (
    <aside ref={root} data-sidebar-root className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-10 shrink-0 items-center">
        <TrafficLights />
        <SidebarToggle onClick={() => p.run("toggle-sidebar")} />
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[52px] shrink-0 flex-col items-center gap-2 pt-1 pb-2">
          {st.workspaces.map((w, index) => {
            const active = w.id === st.activeWorkspace;
            const loud = worstStatus(st.sessions.filter((x) => worktreesOf(st, w.id).some((t) => t.id === x.worktreeId)));
            return (
              <button
                key={w.id}
                type="button"
                data-nav
                data-kind="workspace"
                aria-current={active ? "true" : undefined}
                title={`${w.name}  ${workspaceKeys(index)}`}
                onClick={() => p.update((s) => selectWorkspace(s, w.id))}
                className="group relative grid size-9 place-items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
              >
                <span className={`absolute -left-[8px] w-[3px] rounded-r bg-kumo-default transition-all ${active ? "h-6" : "h-0 group-hover:h-3"}`} />
                <Mark name={w.name} className={`size-9 text-[12px] transition-[border-radius] ${active ? "rounded-xl" : "rounded-[18px] opacity-70 group-hover:rounded-xl group-hover:opacity-100"}`} />
                {!active && loud !== "idle" && (
                  <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-sidebar p-px">
                    <StatusDot status={loud} className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            title="Open workspace ⌘O"
            className="grid size-9 place-items-center rounded-[18px] border border-dashed border-border-strong text-kumo-subtle hover:text-kumo-default"
          >
            <PlusIcon className="size-4" />
          </button>
          <div className="flex-1" />
          <button type="button" title="Settings ⌘," className="grid size-9 place-items-center rounded-xl text-kumo-subtle hover:bg-hover hover:text-kumo-default">
            <GearIcon className="size-[18px]" />
          </button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col rounded-tl-xl border-t border-l border-hairline bg-canvas/40">
          <div className="shrink-0 px-3 pt-3 pb-2">
            <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{ws.name}</div>
            <div className="truncate text-[11px] text-kumo-subtle">{ws.path}</div>
          </div>
          <div className="shrink-0 px-2">
            <SectionHeader
              label="Worktrees"
              p={p}
              extra={
                <button
                  type="button"
                  title={`New worktree ${keysOf("new-worktree")}`}
                  onClick={() => p.run("new-worktree")}
                  className="grid size-6 place-items-center rounded-md text-kumo-subtle hover:bg-hover hover:text-kumo-default"
                >
                  <PlusIcon className="size-4" />
                </button>
              }
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {trees.map((tree) => {
              const index = worktreesOf(st, st.activeWorkspace).findIndex((t) => t.id === tree.id);
              const isCurrent = tree.id === current.id;
              const open = isCurrent || extra.has(tree.id) || p.query.trim().length > 0;
              const sessions = visibleSessions(p, tree);
              const agents = sessions.filter((x) => x.kind === "agent");
              const terminals = sessions.filter((x) => x.kind === "terminal");
              return (
                <div key={tree.id} className={`mt-1 rounded-xl ${isCurrent ? "bg-card ring-1 ring-hairline" : ""}`}>
                  <button
                    type="button"
                    data-nav
                    data-id={tree.id}
                    data-kind="worktree"
                    data-collapse={tree.id}
                    aria-current={isCurrent ? "true" : undefined}
                    title={`${tree.path}  ${worktreeKeys(index)}`}
                    onClick={() => p.update((s) => selectWorktree(s, tree.id))}
                    className="flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-border-strong"
                  >
                    <GitBranchIcon className={`size-4 shrink-0 ${isCurrent ? "" : "text-kumo-subtle"}`} />
                    <span className={`min-w-0 flex-1 truncate ${isCurrent ? "font-semibold" : ""}`}>{tree.branch}</span>
                    {!open && (
                      <span className="flex -space-x-1.5">
                        {sessionsOf(st, tree.id)
                          .filter((x) => x.kind === "agent")
                          .slice(0, 3)
                          .map((x) => (
                            <Face key={x.id} seed={x.id} className="size-5" />
                          ))}
                      </span>
                    )}
                    {open && p.prefs.diff && <DiffStat tree={tree} />}
                    {!open && <StatusDot status={worstStatus(sessionsOf(st, tree.id))} />}
                  </button>
                  {open && (
                    <div className="px-1.5 pb-1.5">
                      {agents.length > 0 && (
                        <div className="grid grid-cols-3 gap-0.5">
                          {agents.map((session) => (
                            <AgentTile
                              key={session.id}
                              session={session}
                              active={session.id === activeSession}
                              names={p.prefs.names}
                              onOpen={() => p.openSession(session.id)}
                            />
                          ))}
                        </div>
                      )}
                      <div className="flex flex-col gap-0.5 pt-0.5">
                        {terminals.map((session) => (
                          <SessionRow key={session.id} session={session} active={session.id === activeSession} onOpen={() => p.openSession(session.id)} />
                        ))}
                      </div>
                      {sessions.length === 0 && (
                        <p className="px-2 py-1.5 text-[12px] text-placeholder">
                          No sessions — {keysOf("new-agent")} agent, {keysOf("new-session")} terminal
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
