// PROTOTYPE — the tab strip, the pane under it, and the pickers two variants share.
import { Menu } from "@base-ui/react/menu";
import {
  CheckIcon,
  FileTextIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PlusIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { StatusDot } from "../../chrome/StatusDot";
import { keysOf, type Cmd } from "./keys";
import {
  activateTab,
  activeTab,
  closeTab,
  currentWorktree,
  sessionById,
  sessionsOf,
  tabLabel,
  visibleTabs,
  workspace,
  worktreeById,
  worktreeHue,
  worktreesOf,
  worstStatus,
  type State,
  type Tab,
} from "./store";
import { BranchDot, DiffStat, Face, Mark, SidebarToggle, TrafficLights, workspaceKeys, worktreeKeys } from "./ui";

// ── Tab strip ──────────────────────────────────────────────────────────

export function TabBar({ st, update, run }: { st: State; update: (fn: (st: State) => State) => void; run: (cmd: Cmd) => void }) {
  const tabs = visibleTabs(st);
  const active = activeTab(st);
  const tree = currentWorktree(st);
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border bg-sidebar">
      {!st.sidebar && (
        <>
          <TrafficLights />
          <SidebarToggle onClick={() => run("toggle-sidebar")} />
          {/* With the rail gone, the context has to be said somewhere. */}
          <button
            type="button"
            title={`Switch ${keysOf("switch-context")}`}
            onClick={() => run("switch-context")}
            className="mx-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-kumo-subtle hover:bg-hover hover:text-kumo-default"
          >
            <span className="font-medium text-kumo-default">{workspace(st).name}</span>
            <span>›</span>
            <GitBranchIcon className="size-3.5" />
            <span>{tree.branch}</span>
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      <div className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5">
        {tabs.map((tab) => (
          <Pill
            key={tab.id}
            st={st}
            tab={tab}
            active={tab.id === active?.id}
            onSelect={() => update((s) => activateTab(s, tab.id))}
            onClose={() => update((s) => closeTab(s, tab.id))}
          />
        ))}
        <button
          type="button"
          title={`New tab ${keysOf("new-tab")}`}
          onClick={() => run("new-tab")}
          className="grid size-7 shrink-0 place-items-center rounded-chrome text-kumo-subtle hover:bg-hover hover:text-kumo-default"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function Pill({ st, tab, active, onSelect, onClose }: { st: State; tab: Tab; active: boolean; onSelect: () => void; onClose: () => void }) {
  const session = tab.kind === "session" ? sessionById(st, tab.sessionId) : undefined;
  const tree = worktreeById(st, tab.worktreeId);
  const foreign = st.tabMode === "all";
  return (
    <div
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onAuxClick={(event) => event.button === 1 && onClose()}
      title={`${tabLabel(st, tab)} — ${tree?.branch}`}
      className={`group relative flex h-7 max-w-[210px] min-w-[120px] shrink-0 items-center gap-1.5 rounded-chrome pr-1.5 pl-2.5 ring-1 transition-colors ${
        active ? "bg-canvas text-text shadow-[0_1px_2px_var(--color-hairline)] ring-hairline" : "bg-card text-text-muted ring-transparent hover:bg-hover"
      }`}
    >
      {tab.kind === "file" ? (
        <FileTextIcon className="size-4 shrink-0" />
      ) : session?.kind === "agent" ? (
        <Face seed={session.id} className="size-4" />
      ) : (
        <TerminalWindowIcon className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{tabLabel(st, tab)}</span>
      {/* All mode: every pill says which tree it belongs to. */}
      {foreign && tree && (
        <span className="flex max-w-[70px] shrink-0 items-center gap-1 text-[11px] text-kumo-subtle">
          <BranchDot hue={worktreeHue(st, tree.id)} className="size-1.5" />
          <span className="truncate">{tree.branch.split("/").pop()}</span>
        </span>
      )}
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        {session && session.status !== "idle" && (
          <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0">
            <StatusDot status={session.status} />
          </span>
        )}
        <button
          type="button"
          aria-label="Close tab"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={`absolute grid size-5 place-items-center rounded-full hover:bg-selected ${
            active && (!session || session.status === "idle") ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  );
}

// ── Pane ───────────────────────────────────────────────────────────────

export function Pane({ st, run }: { st: State; run: (cmd: Cmd) => void }) {
  const tab = activeTab(st);
  const tree = tab ? worktreeById(st, tab.worktreeId)! : currentWorktree(st);
  const session = tab?.kind === "session" ? sessionById(st, tab.sessionId) : undefined;
  return (
    <div data-main tabIndex={-1} className="flex min-h-0 flex-1 flex-col bg-canvas outline-none">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-4 text-[12px] text-kumo-subtle">
        <BranchDot hue={worktreeHue(st, tree.id)} />
        <span className="text-kumo-default">{workspace(st).name}</span>›<span>{tree.branch}</span>
        <span className="truncate font-mono text-[11px]">{tree.path}</span>
      </div>
      {!tab && (
        <div className="grid flex-1 place-items-center">
          <div className="flex flex-col items-center gap-3 text-kumo-subtle">
            <span>
              Nothing open in <span className="text-kumo-default">{tree.branch}</span>
            </span>
            <div className="flex flex-col gap-1 text-[12px]">
              {(["new-agent", "new-session", "go-to-file", "switch-context", "shortcuts"] as Cmd[]).map((cmd) => (
                <button key={cmd} type="button" onClick={() => run(cmd)} className="flex w-64 justify-between rounded px-2 py-1 hover:bg-hover">
                  <span>{
                    { "new-agent": "New agent", "new-session": "New session", "go-to-file": "Open file", "switch-context": "Switch worktree", shortcuts: "All shortcuts" }[cmd as string]
                  }</span>
                  <span>{keysOf(cmd)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {session?.kind === "agent" && (
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 p-8">
          <div className="flex items-center gap-3">
            <Face seed={session.id} className="size-12" />
            <div>
              <div className="text-[16px] font-semibold">{session.name}</div>
              <div className="text-[12px] text-kumo-subtle">working in {tree.branch}</div>
            </div>
          </div>
          <div className="self-end rounded-2xl bg-kumo-brand px-3.5 py-2 text-kumo-inverse">Refactor the sidebar so worktrees are first-class.</div>
          <p className="text-kumo-subtle">
            Reading <code>src/chrome/SessionSidebar.tsx</code> in <code>{tree.path}</code>…
          </p>
          {session.status === "needs-input" && (
            <div className="rounded-lg bg-kumo-warning/10 p-3 ring ring-kumo-warning/40">Allow <code>npm install</code>? · Allow ⌘↵ · Deny ⌘⌫</div>
          )}
        </div>
      )}
      {session?.kind === "terminal" && (
        <pre className="flex-1 p-4 font-mono text-[12px] leading-5 text-kumo-default">
          <span className="text-kumo-subtle">{tree.path}</span> <span className="text-[oklch(62%_0.15_150)]">({tree.branch})</span> ${" "}
          {session.name}
          {"\n"}
          {session.status === "working" ? "  VITE ready in 312 ms\n  ➜  Local: http://127.0.0.1:1420/" : ""}
        </pre>
      )}
      {tab?.kind === "file" && (
        <pre className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 text-kumo-subtle">
          {`// ${tree.branch} · ${tab.path}\n\nexport function ${tab.path.split("/").pop()!.replace(/\W.*/, "")}() {\n  // the same path can be open once per worktree\n}\n`}
        </pre>
      )}
    </div>
  );
}

// ── Pickers ────────────────────────────────────────────────────────────

const PANEL =
  "w-[280px] origin-(--transform-origin) overflow-hidden rounded-xl bg-kumo-control p-1.5 text-kumo-default shadow-xl ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-[0.98] data-starting-style:opacity-0";
const ITEM = "flex h-10 w-full cursor-default items-center gap-2.5 rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover";

export function WorkspaceMenu({
  st,
  onSelect,
  onOpen,
  children,
  className,
}: {
  st: State;
  onSelect: (id: string) => void;
  onOpen: () => void;
  children: ReactNode;
  className: string;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger data-nav className={className}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {st.workspaces.map((ws, index) => (
              <Menu.Item key={ws.id} onClick={() => onSelect(ws.id)} className={ITEM}>
                <Mark name={ws.name} className="size-5 rounded-[5px] text-[10px]" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{ws.name}</span>
                  <span className="truncate text-[11px] text-kumo-subtle">
                    {worktreesOf(st, ws.id).length} worktrees · {ws.path}
                  </span>
                </span>
                {ws.id === st.activeWorkspace ? <CheckIcon className="size-3.5" /> : <span className="text-[11px] text-kumo-subtle">{workspaceKeys(index)}</span>}
              </Menu.Item>
            ))}
            <Menu.Separator className="mx-1 my-1 h-px bg-kumo-line" />
            <Menu.Item onClick={onOpen} className={`${ITEM} h-8`}>
              <FolderPlusIcon className="size-4 text-kumo-subtle" />
              <span className="flex-1">Open workspace…</span>
              <span className="text-[11px] text-kumo-subtle">⌘O</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function WorktreeMenu({
  st,
  onSelect,
  onNew,
  children,
  className,
}: {
  st: State;
  onSelect: (id: string) => void;
  onNew: () => void;
  children: ReactNode;
  className: string;
}) {
  const current = currentWorktree(st).id;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger data-nav className={className}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            {worktreesOf(st, st.activeWorkspace).map((tree, index) => (
              <Menu.Item key={tree.id} onClick={() => onSelect(tree.id)} className={ITEM}>
                <GitBranchIcon className="size-4 shrink-0 text-kumo-subtle" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium">{tree.branch}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-kumo-subtle">
                    {sessionsOf(st, tree.id).length} sessions <DiffStat tree={tree} />
                  </span>
                </span>
                <StatusDot status={worstStatus(sessionsOf(st, tree.id))} />
                {tree.id === current ? <CheckIcon className="size-3.5" /> : <span className="text-[11px] text-kumo-subtle">{worktreeKeys(index)}</span>}
              </Menu.Item>
            ))}
            <Menu.Separator className="mx-1 my-1 h-px bg-kumo-line" />
            <Menu.Item onClick={onNew} className={`${ITEM} h-8`}>
              <PlusIcon className="size-4 text-kumo-subtle" />
              <span className="flex-1">New worktree…</span>
              <span className="text-[11px] text-kumo-subtle">{keysOf("new-worktree")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

