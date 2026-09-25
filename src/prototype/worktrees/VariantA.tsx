// PROTOTYPE — A · Tree. Workspace card on top, every worktree a folding group
// holding its agents as a face grid and its sessions as rows.
import { CaretUpDownIcon, GearIcon, GitBranchIcon, RobotIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { keysOf } from "./keys";
import { WorkspaceMenu } from "./shell";
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
  AgentTile,
  Mark,
  SectionHeader,
  SessionRow,
  SidebarToggle,
  TrafficLights,
  WorktreeHeader,
  useSidebarKeys,
  visibleSessions,
  visibleWorktrees,
  worktreeKeys,
  type SidebarProps,
} from "./ui";

export function VariantA(p: SidebarProps) {
  const root = useRef<HTMLElement>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const st = p.st;
  const ws = workspace(st);
  const current = currentWorktree(st);
  const tab = activeTab(st);
  const activeSession = tab?.kind === "session" ? tab.sessionId : null;

  useSidebarKeys(root, {
    toggle: (id, open) =>
      setFolded((prev) => {
        const next = new Set(prev);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      }),
    rename: p.askRename,
    remove: p.askRemove,
    search: () => p.setSearching(true),
  });

  const trees = visibleWorktrees(p);

  return (
    <aside ref={root} data-sidebar-root className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-10 shrink-0 items-center">
        <TrafficLights />
        <SidebarToggle onClick={() => p.run("toggle-sidebar")} />
      </div>

      {/* The card has a surface of its own: it is a control, not a heading. */}
      <div className="shrink-0 px-[11px] pb-3">
        <WorkspaceMenu
          st={st}
          onSelect={(id) => p.update((s) => selectWorkspace(s, id))}
          onOpen={() => {}}
          className="flex w-full items-center gap-2.5 rounded-xl bg-card px-2.5 py-2 text-left ring-1 ring-hairline transition-colors outline-none hover:bg-hover focus-visible:ring-border-strong data-popup-open:bg-hover"
        >
          <Mark name={ws.name} className="size-8 rounded-lg text-[12px]" />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em]">{ws.name}</span>
            <span className="flex items-center gap-1 text-[12px] text-kumo-subtle">
              <GitBranchIcon className="size-3" />
              <span className="truncate">{current.branch}</span>
            </span>
          </span>
          <CaretUpDownIcon className="size-4 shrink-0 text-kumo-subtle" />
        </WorkspaceMenu>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-[11px] pb-3">
        <ActionRow icon={RobotIcon} label="New agent" keys={keysOf("new-agent")} onClick={() => p.run("new-agent")} />
        <ActionRow icon={TerminalWindowIcon} label="New session" keys={keysOf("new-session")} onClick={() => p.run("new-session")} />
        <ActionRow icon={GitBranchIcon} label="New worktree" keys={keysOf("new-worktree")} onClick={() => p.run("new-worktree")} />
      </div>

      <div className="shrink-0 px-[11px]">
        <SectionHeader label="Worktrees" p={p} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[11px] pb-3">
        {trees.map((tree) => {
          const index = worktreesOf(st, st.activeWorkspace).findIndex((t) => t.id === tree.id);
          const sessions = visibleSessions(p, tree);
          const agents = sessions.filter((x) => x.kind === "agent");
          const terminals = sessions.filter((x) => x.kind === "terminal");
          const open = !folded.has(tree.id) || p.query.trim().length > 0;
          return (
            <section key={tree.id} className="pt-2">
              <WorktreeHeader
                tree={tree}
                status={worstStatus(sessionsOf(st, tree.id))}
                active={tree.id === current.id}
                open={open}
                showDiff={p.prefs.diff}
                hint={worktreeKeys(index)}
                onToggle={() =>
                  setFolded((prev) => {
                    const next = new Set(prev);
                    if (next.has(tree.id)) next.delete(tree.id);
                    else next.add(tree.id);
                    return next;
                  })
                }
                onSelect={() => p.update((s) => selectWorktree(s, tree.id))}
                onAdd={() => {
                  p.update((s) => selectWorktree(s, tree.id));
                  p.run("new-agent");
                }}
              />
              {open && (
                <div className={`ml-[9px] border-l pl-1.5 ${tree.id === current.id ? "border-border-strong" : "border-hairline"}`}>
                  {agents.length > 0 && (
                    <div className="grid grid-cols-3 gap-0.5 py-1">
                      {agents.map((session) => (
                        <AgentTile
                          key={session.id}
                          session={session}
                          active={session.id === activeSession}
                          names={p.prefs.names}
                          size="sm"
                          onOpen={() => p.openSession(session.id)}
                        />
                      ))}
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5">
                    {terminals.map((session) => (
                      <SessionRow key={session.id} session={session} active={session.id === activeSession} onOpen={() => p.openSession(session.id)} />
                    ))}
                  </div>
                  {sessions.length === 0 && <p className="px-2 py-1.5 text-[12px] text-placeholder">Empty — {keysOf("new-agent")}</p>}
                </div>
              )}
            </section>
          );
        })}
        {trees.length === 0 && <p className="px-2 py-1.5 text-placeholder">No matches</p>}
      </div>

      <div className="shrink-0 px-[11px] py-2">
        <ActionRow icon={GearIcon} label="Settings" keys="⌘," onClick={() => {}} />
      </div>
    </aside>
  );
}
