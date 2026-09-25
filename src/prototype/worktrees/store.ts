// PROTOTYPE — throwaway. Worktrees + sidebar redesign, in-memory only.
// Question: what should crew's sidebar look like once a workspace holds worktrees,
// and should tabs be per worktree or all together? Open /prototype.html.
import { STATUS_ORDER } from "../../lib/status";
import type { SessionStatus } from "../../lib/types";

export type Workspace = { id: string; name: string; path: string };
export type Worktree = {
  id: string;
  workspaceId: string;
  branch: string;
  path: string;
  main: boolean;
  add: number;
  del: number;
  dirty: number;
};
export type Session = {
  id: string;
  worktreeId: string;
  kind: "agent" | "terminal";
  name: string;
  status: SessionStatus;
};
export type Tab =
  | { id: string; worktreeId: string; kind: "session"; sessionId: string }
  | { id: string; worktreeId: string; kind: "file"; path: string };
export type TabMode = "worktree" | "all";

export type State = {
  workspaces: Workspace[];
  worktrees: Worktree[];
  sessions: Session[];
  tabs: Tab[];
  activeWorkspace: string;
  /** Last worktree on screen, per workspace. */
  activeWorktree: Record<string, string>;
  /** Active tab per context: `wt:<id>` in per-worktree mode, `ws:<id>` in all mode. */
  activeTab: Record<string, string | null>;
  tabMode: TabMode;
  sidebar: boolean;
  closed: Tab[];
};

let seq = 100;
export const uid = (prefix: string) => `${prefix}${++seq}`;

const wt = (
  id: string,
  workspaceId: string,
  branch: string,
  path: string,
  main: boolean,
  add = 0,
  del = 0,
  dirty = 0,
): Worktree => ({ id, workspaceId, branch, path, main, add, del, dirty });

const s = (
  id: string,
  worktreeId: string,
  kind: Session["kind"],
  name: string,
  status: SessionStatus = "idle",
): Session => ({ id, worktreeId, kind, name, status });

export const INITIAL: State = {
  workspaces: [
    { id: "crew", name: "crew", path: "~/Developer/experiments/crew" },
    { id: "furry", name: "furry", path: "~/Developer/furry" },
    { id: "nerb", name: "nerblabs", path: "~/Developer/nerblabs" },
  ],
  worktrees: [
    wt("crew-main", "crew", "master", "~/Developer/experiments/crew", true, 0, 0, 2),
    wt("crew-wt", "crew", "feat/worktrees", "~/.crew/worktrees/crew/feat-worktrees", false, 214, 38, 5),
    wt("crew-av", "crew", "feat/avatars", "~/.crew/worktrees/crew/feat-avatars", false, 42, 7, 0),
    wt("crew-sock", "crew", "fix/socket-replay", "~/.crew/worktrees/crew/fix-socket-replay", false, 12, 3, 1),
    wt("furry-main", "furry", "main", "~/Developer/furry", true),
    wt("furry-co", "furry", "feat/checkout", "~/.crew/worktrees/furry/feat-checkout", false, 88, 20, 3),
    wt("nerb-main", "nerb", "main", "~/Developer/nerblabs", true),
  ],
  sessions: [
    s("a1", "crew-main", "agent", "Cuddles", "done"),
    s("a2", "crew-main", "agent", "Research"),
    s("t1", "crew-main", "terminal", "zsh"),
    s("t2", "crew-main", "terminal", "npm run dev", "working"),
    s("a3", "crew-wt", "agent", "Mochi", "working"),
    s("a4", "crew-wt", "agent", "Tofu", "needs-input"),
    s("a5", "crew-wt", "agent", "Biscuit"),
    s("t3", "crew-wt", "terminal", "cargo test"),
    s("a6", "crew-av", "agent", "Olive", "working"),
    s("t4", "crew-av", "terminal", "zsh"),
    s("a7", "crew-sock", "agent", "Pixel", "error"),
    s("a8", "furry-main", "agent", "Furry"),
    s("t5", "furry-main", "terminal", "zsh"),
    s("a9", "furry-co", "agent", "Nerb", "needs-input"),
    s("a10", "nerb-main", "agent", "Nerblabs", "done"),
  ],
  tabs: [
    { id: "tab1", worktreeId: "crew-main", kind: "session", sessionId: "a1" },
    { id: "tab2", worktreeId: "crew-main", kind: "session", sessionId: "t2" },
    { id: "tab3", worktreeId: "crew-main", kind: "file", path: "src/App.tsx" },
    { id: "tab4", worktreeId: "crew-wt", kind: "session", sessionId: "a3" },
    { id: "tab5", worktreeId: "crew-wt", kind: "session", sessionId: "a4" },
    { id: "tab6", worktreeId: "crew-wt", kind: "file", path: "src/hooks/useTabs.ts" },
    { id: "tab7", worktreeId: "crew-av", kind: "session", sessionId: "a6" },
    { id: "tab8", worktreeId: "furry-main", kind: "session", sessionId: "a8" },
  ],
  activeWorkspace: "crew",
  activeWorktree: { crew: "crew-wt", furry: "furry-main", nerb: "nerb-main" },
  activeTab: { "wt:crew-main": "tab1", "wt:crew-wt": "tab4", "wt:crew-av": "tab7", "wt:furry-main": "tab8" },
  tabMode: "worktree",
  sidebar: true,
  closed: [],
};

// ── Reads ──────────────────────────────────────────────────────────────

export const workspace = (st: State) =>
  st.workspaces.find((w) => w.id === st.activeWorkspace) ?? st.workspaces[0]!;

export const worktreesOf = (st: State, workspaceId: string) =>
  st.worktrees.filter((w) => w.workspaceId === workspaceId);

export function currentWorktree(st: State): Worktree {
  const list = worktreesOf(st, st.activeWorkspace);
  return list.find((w) => w.id === st.activeWorktree[st.activeWorkspace]) ?? list[0]!;
}

export const worktreeById = (st: State, id: string) => st.worktrees.find((w) => w.id === id);
export const sessionById = (st: State, id: string) => st.sessions.find((x) => x.id === id);
export const sessionsOf = (st: State, worktreeId: string) =>
  st.sessions.filter((x) => x.worktreeId === worktreeId);

const ctxKey = (st: State) =>
  st.tabMode === "worktree" ? `wt:${currentWorktree(st).id}` : `ws:${st.activeWorkspace}`;

export function visibleTabs(st: State): Tab[] {
  if (st.tabMode === "worktree") {
    const id = currentWorktree(st).id;
    return st.tabs.filter((t) => t.worktreeId === id);
  }
  return st.tabs.filter((t) => worktreeById(st, t.worktreeId)?.workspaceId === st.activeWorkspace);
}

export function activeTab(st: State): Tab | null {
  const id = st.activeTab[ctxKey(st)];
  return visibleTabs(st).find((t) => t.id === id) ?? null;
}

/** The loudest status among a worktree's sessions. */
export function worstStatus(sessions: Session[]): SessionStatus {
  for (const status of STATUS_ORDER) if (sessions.some((x) => x.status === status)) return status;
  return "idle";
}

/** A stable hue per worktree, so a tab's chip and its sidebar group agree. */
const HUES = [250, 150, 25, 300, 80, 190];
export function worktreeHue(st: State, id: string): number {
  const tree = worktreeById(st, id);
  if (!tree) return 0;
  const index = worktreesOf(st, tree.workspaceId).findIndex((w) => w.id === id);
  return HUES[index % HUES.length]!;
}

export const tabLabel = (st: State, tab: Tab) =>
  tab.kind === "file" ? tab.path.split("/").pop()! : (sessionById(st, tab.sessionId)?.name ?? "?");

// ── Writes ─────────────────────────────────────────────────────────────

function setActiveTab(st: State, tabId: string | null): State {
  return { ...st, activeTab: { ...st.activeTab, [ctxKey(st)]: tabId } };
}

export function selectWorkspace(st: State, id: string): State {
  return st.workspaces.some((w) => w.id === id) ? { ...st, activeWorkspace: id } : st;
}

export function selectWorktree(st: State, id: string): State {
  const tree = worktreeById(st, id);
  if (!tree) return st;
  const next: State = {
    ...st,
    activeWorkspace: tree.workspaceId,
    activeWorktree: { ...st.activeWorktree, [tree.workspaceId]: id },
  };
  // In all mode the strip belongs to the workspace; switching worktree lands on
  // that worktree's last tab so the context and the tab agree.
  if (st.tabMode === "all") {
    const own = next.tabs.find((t) => t.id === next.activeTab[`wt:${id}`]) ?? next.tabs.find((t) => t.worktreeId === id);
    if (own) return setActiveTab(next, own.id);
  }
  return next;
}

export function stepWorkspace(st: State, delta: number): State {
  const i = st.workspaces.findIndex((w) => w.id === st.activeWorkspace);
  const n = st.workspaces.length;
  return selectWorkspace(st, st.workspaces[(i + delta + n) % n]!.id);
}

export function stepWorktree(st: State, delta: number): State {
  const list = worktreesOf(st, st.activeWorkspace);
  const i = list.findIndex((w) => w.id === currentWorktree(st).id);
  return selectWorktree(st, list[(i + delta + list.length) % list.length]!.id);
}

export function activateTab(st: State, tabId: string): State {
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab) return st;
  // Context follows the tab: in all mode, picking a tab from another worktree moves you there.
  let next = { ...st, activeWorkspace: worktreeById(st, tab.worktreeId)!.workspaceId };
  next = { ...next, activeWorktree: { ...next.activeWorktree, [next.activeWorkspace]: tab.worktreeId } };
  next = { ...next, activeTab: { ...next.activeTab, [`wt:${tab.worktreeId}`]: tabId } };
  return setActiveTab(next, tabId);
}

export function openSession(st: State, sessionId: string): State {
  const session = sessionById(st, sessionId);
  if (!session) return st;
  const existing = st.tabs.find((t) => t.kind === "session" && t.sessionId === sessionId);
  if (existing) return activateTab(st, existing.id);
  const tab: Tab = { id: uid("tab"), worktreeId: session.worktreeId, kind: "session", sessionId };
  return activateTab({ ...st, tabs: [...st.tabs, tab] }, tab.id);
}

export function openFile(st: State, path: string): State {
  const worktreeId = currentWorktree(st).id;
  const existing = st.tabs.find((t) => t.kind === "file" && t.path === path && t.worktreeId === worktreeId);
  if (existing) return activateTab(st, existing.id);
  const tab: Tab = { id: uid("tab"), worktreeId, kind: "file", path };
  return activateTab({ ...st, tabs: [...st.tabs, tab] }, tab.id);
}

export function closeTab(st: State, tabId?: string): State {
  const visible = visibleTabs(st);
  const id = tabId ?? activeTab(st)?.id;
  const index = visible.findIndex((t) => t.id === id);
  if (index < 0) return st;
  const tab = visible[index]!;
  const rest = visible.filter((t) => t.id !== id);
  const neighbour = rest[Math.min(index, rest.length - 1)] ?? null;
  const next: State = { ...st, tabs: st.tabs.filter((t) => t.id !== id), closed: [...st.closed, tab] };
  return activeTab(st)?.id === id ? setActiveTab(next, neighbour?.id ?? null) : next;
}

export function reopenTab(st: State): State {
  const tab = st.closed[st.closed.length - 1];
  if (!tab) return st;
  if (tab.kind === "session" && !sessionById(st, tab.sessionId)) return { ...st, closed: st.closed.slice(0, -1) };
  return activateTab({ ...st, tabs: [...st.tabs, tab], closed: st.closed.slice(0, -1) }, tab.id);
}

export function stepTab(st: State, delta: number): State {
  const visible = visibleTabs(st);
  if (visible.length === 0) return st;
  const i = visible.findIndex((t) => t.id === activeTab(st)?.id);
  return activateTab(st, visible[(i + delta + visible.length) % visible.length]!.id);
}

export function createWorktree(st: State, branch: string): [State, string] {
  const ws = workspace(st);
  const slug = branch.replace(/[^\w.-]+/g, "-");
  const tree = wt(uid("wt"), ws.id, branch, `~/.crew/worktrees/${ws.name}/${slug}`, false);
  const next = { ...st, worktrees: [...st.worktrees, tree] };
  return [selectWorktree(next, tree.id), tree.id];
}

export function createSession(st: State, worktreeId: string, kind: Session["kind"], name: string): State {
  const session = s(uid(kind === "agent" ? "a" : "t"), worktreeId, kind, name, kind === "agent" ? "working" : "idle");
  return openSession({ ...st, sessions: [...st.sessions, session] }, session.id);
}

export function removeSession(st: State, id: string): State {
  const gone = new Set(st.tabs.flatMap((t) => (t.kind === "session" && t.sessionId === id ? [t.id] : [])));
  const current = activeTab(st);
  const next = current && gone.has(current.id) ? closeTab(st) : st;
  return {
    ...next,
    tabs: next.tabs.filter((t) => !gone.has(t.id)),
    sessions: next.sessions.filter((x) => x.id !== id),
  };
}

export function removeWorktree(st: State, id: string): State {
  const tree = worktreeById(st, id);
  if (!tree || tree.main) return st;
  const main = worktreesOf(st, tree.workspaceId).find((w) => w.main)!;
  const next: State = {
    ...st,
    worktrees: st.worktrees.filter((w) => w.id !== id),
    sessions: st.sessions.filter((x) => x.worktreeId !== id),
    tabs: st.tabs.filter((t) => t.worktreeId !== id),
  };
  return st.activeWorktree[tree.workspaceId] === id ? selectWorktree(next, main.id) : next;
}

export function rename(st: State, id: string, name: string): State {
  return { ...st, sessions: st.sessions.map((x) => (x.id === id ? { ...x, name } : x)) };
}

/** Seen once opened: a finished turn stops calling for attention. */
export function markSeen(st: State, id: string): State {
  const session = sessionById(st, id);
  if (session?.status !== "done") return st;
  return { ...st, sessions: st.sessions.map((x) => (x.id === id ? { ...x, status: "idle" } : x)) };
}

export function setTabMode(st: State, mode: TabMode): State {
  if (mode === st.tabMode) return st;
  const current = activeTab(st);
  const next = { ...st, tabMode: mode };
  return current ? setActiveTab(next, current.id) : next;
}

export const AGENT_NAMES = ["Juniper", "Waffles", "Pepper", "Noodle", "Maple", "Sprout", "Ziggy", "Clover", "Bean", "Poppy"];

export function nextAgentName(st: State): string {
  const taken = new Set(st.sessions.map((x) => x.name));
  return AGENT_NAMES.find((n) => !taken.has(n)) ?? `Agent ${st.sessions.length + 1}`;
}

export const FILES = [
  "src/App.tsx",
  "src/main.tsx",
  "src/chrome/SessionSidebar.tsx",
  "src/chrome/WorkspacePicker.tsx",
  "src/chrome/TabBar.tsx",
  "src/hooks/useTabs.ts",
  "src/lib/workspaces.ts",
  "src/lib/commands.ts",
  "crates/crew-core/src/store.rs",
  "README.md",
];
