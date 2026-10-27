// What the app last learned about the workspaces and the checkouts under
// them, shared by whoever reads it: the sidebar's hooks publish every answer
// they get, and the chat's context row reads the same one, so a branch
// switched or a workspace renamed shows where it is used without a launch.
import { listWorkspaces, listWorktrees } from "./api";
import { onWorkspacesChanged } from "./client/registry";
import type { Workspace, Worktree } from "./types";

const trim = (path: string) => path.replace(/\/+$/, "");

let workspaces: Workspace[] | null = null;
const trees = new Map<string, Worktree | null>();
/** Which repository answered for a checkout, so a checkout it stops listing is told apart from one it never spoke for. */
const repoOf = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Changes whenever anything below does, for useSyncExternalStore. */
export const placesVersion = () => version;

export const workspacesKnown = () => workspaces;

/** The checkout at `root`: undefined until asked, null when it is not one git lists. */
export const treeKnown = (root: string): Worktree | null | undefined => trees.get(trim(root));

export function publishWorkspaces(list: Workspace[]) {
  workspaces = list;
  bump();
}

/** git's list for the repository at `root`: every checkout in it becomes known, and one that is gone no longer is. */
export function publishWorktrees(root: string, list: Worktree[]) {
  const wanted = trim(root);
  const paths = new Set(list.map((tree) => trim(tree.path)));
  paths.add(wanted);
  const group = [...paths].find((path) => repoOf.has(path)) ?? wanted;
  const repo = repoOf.get(group) ?? wanted;
  for (const [path, owner] of repoOf) if (owner === repo && !paths.has(path)) trees.set(path, null);
  for (const path of paths) repoOf.set(path, repo);
  for (const path of paths) trees.set(path, null);
  for (const tree of list) trees.set(trim(tree.path), tree);
  bump();
}

/** Every checkout git lists for the repository `root` is in, the main one first; empty until git has answered. */
export function treesOf(root: string): Worktree[] {
  const repo = repoOf.get(trim(root));
  if (!repo) return [];
  const list: Worktree[] = [];
  for (const [path, owner] of repoOf) {
    const tree = owner === repo ? trees.get(path) : null;
    if (tree) list.push(tree);
  }
  return list.sort((a, b) => Number(b.main) - Number(a.main));
}

/** The branch the repository's main checkout is on, which is where its work lands: the real default, not a guess. */
export function mainBranchOf(root: string): string | null {
  const repo = repoOf.get(trim(root));
  if (!repo) return null;
  for (const [path, owner] of repoOf) {
    const tree = owner === repo ? trees.get(path) : null;
    if (tree?.main && tree.branch) return tree.branch;
  }
  return null;
}

const treesInFlight = new Map<string, Promise<void>>();
let workspacesInFlight: Promise<void> | null = null;

/** Asks git for the repository at `root` and publishes the answer; one ask at a time per root, however many readers want it. */
export function readTrees(root: string): Promise<void> {
  const key = trim(root);
  const running = treesInFlight.get(key);
  if (running) return running;
  const ask = listWorktrees(key)
    .then(
      (list) => publishWorktrees(key, list),
      () => {
        if (treeKnown(key) === undefined) publishWorktrees(key, []);
      },
    )
    .finally(() => void treesInFlight.delete(key));
  treesInFlight.set(key, ask);
  return ask;
}

/** Asks for the workspaces and publishes the answer; concurrent asks share one. */
export function readWorkspaces(): Promise<void> {
  if (workspacesInFlight) return workspacesInFlight;
  const ask = listWorkspaces()
    .then(publishWorkspaces, () => {
      if (workspacesKnown() === null) publishWorkspaces([]);
    })
    .finally(() => {
      workspacesInFlight = null;
    });
  workspacesInFlight = ask;
  return ask;
}

// The checkouts some reader shows, counted. The window coming back and a
// workspace changing are watched once for all of them, from the first watcher
// to the last, instead of once per reader.
const watchedRoots = new Map<string, number>();
let watchers = 0;
let stopWatching: (() => void) | null = null;

function startWatching() {
  const onFocus = () => {
    for (const root of watchedRoots.keys()) void readTrees(root);
  };
  window.addEventListener("focus", onFocus);
  const offWorkspaces = onWorkspacesChanged(() => void readWorkspaces());
  stopWatching = () => {
    window.removeEventListener("focus", onFocus);
    offWorkspaces();
  };
}

/** Keeps the places fresh while a reader shows them: `root` is re-read when the window gets focus, workspaces when they change. */
export function watchPlaces(root: string | null): () => void {
  const key = root ? trim(root) : null;
  if (key) watchedRoots.set(key, (watchedRoots.get(key) ?? 0) + 1);
  watchers += 1;
  if (watchers === 1) startWatching();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (key) {
      const left = (watchedRoots.get(key) ?? 1) - 1;
      if (left <= 0) watchedRoots.delete(key);
      else watchedRoots.set(key, left);
    }
    watchers -= 1;
    if (watchers === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}
