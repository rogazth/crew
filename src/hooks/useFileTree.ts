import { useEffect, useMemo, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { foldersTo, sameEntries, visibleRows } from "../lib/fileTree";
import type { FolderEntry } from "../lib/protocol";

type Snapshot = {
  children: ReadonlyMap<string, FolderEntry[]>;
  expanded: ReadonlySet<string>;
  /** Why the root could not be listed, in the daemon's words. */
  error: string | null;
};

/**
 * One workspace folder's tree: the folders listed so far and which are open.
 * Kept per root for the window's life, so switching worktrees and back finds
 * the tree as it was left.
 */
class Tree {
  snapshot: Snapshot = { children: new Map(), expanded: new Set(), error: null };
  private listeners = new Set<() => void>();
  private loading = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Lists `dir` again; a folder that went away is closed and forgotten. */
  load(dir: string): Promise<void> {
    const running = this.loading.get(dir);
    if (running) return running;
    const done = api
      .listFolder(dir)
      .then((entries) => {
        if (dir === this.root && this.snapshot.error) this.set({ error: null });
        if (sameEntries(this.snapshot.children.get(dir), entries)) return;
        this.set({ children: new Map(this.snapshot.children).set(dir, entries) });
      })
      .catch((error: unknown) => {
        if (dir === this.root) {
          this.set({ error: String(error) });
          return;
        }
        const children = new Map(this.snapshot.children);
        children.delete(dir);
        const expanded = new Set(this.snapshot.expanded);
        expanded.delete(dir);
        this.set({ children, expanded });
      })
      .finally(() => this.loading.delete(dir));
    this.loading.set(dir, done);
    return done;
  }

  toggle(dir: string, open = !this.snapshot.expanded.has(dir)) {
    const expanded = new Set(this.snapshot.expanded);
    if (open) expanded.add(dir);
    else expanded.delete(dir);
    this.set({ expanded });
    // Listed again on every open: what an agent wrote since shows up.
    if (open) void this.load(dir);
  }

  collapseAll() {
    this.set({ expanded: new Set() });
  }

  /** Every folder on screen, listed again. */
  refresh(): Promise<void> {
    const shown = [this.root];
    for (const row of visibleRows(this.root, this.snapshot.children, this.snapshot.expanded)) {
      if (row.expanded) shown.push(row.entry.path);
    }
    return Promise.all(shown.map((dir) => this.load(dir))).then(() => {});
  }

  /** Opens the folders down to `path`, each listed before the next. */
  async reveal(path: string): Promise<void> {
    const folders = foldersTo(this.root, path);
    if (folders.length === 0 && !path.startsWith(`${this.root}/`)) return;
    const expanded = new Set(this.snapshot.expanded);
    for (const folder of folders) expanded.add(folder);
    this.set({ expanded });
    for (const dir of [this.root, ...folders]) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a folder is listed once its parent is
      if (!this.snapshot.children.has(dir)) await this.load(dir);
    }
  }
}

const trees = new Map<string, Tree>();

function treeFor(root: string): Tree {
  let tree = trees.get(root);
  if (!tree) {
    tree = new Tree(root);
    trees.set(root, tree);
  }
  return tree;
}

const EMPTY: Snapshot = { children: new Map(), expanded: new Set(), error: null };
const noop = () => () => {};

/** How often the folders on screen are listed again while the explorer shows them. */
const REFRESH_MS = 3000;

/**
 * The explorer's tree for `root`. While `live`, the folders on screen are
 * listed again every few seconds and when the window comes back, since
 * agents write files the whole time.
 */
export function useFileTree(root: string | null, live: boolean) {
  const tree = root ? treeFor(root) : null;
  const snapshot = useSyncExternalStore(tree?.subscribe ?? noop, () => tree?.snapshot ?? EMPTY);

  useEffect(() => {
    if (!tree || !live) return;
    void tree.refresh();
    const tick = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) void tree.refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [tree, live]);

  const rows = useMemo(
    () => (root ? visibleRows(root, snapshot.children, snapshot.expanded) : []),
    [root, snapshot],
  );

  // Stable per tree, so effects can depend on them.
  const actions = useMemo(
    () => ({
      toggle: (dir: string, open?: boolean) => tree?.toggle(dir, open),
      collapseAll: () => tree?.collapseAll(),
      refresh: () => tree?.refresh() ?? Promise.resolve(),
      reveal: (path: string) => tree?.reveal(path) ?? Promise.resolve(),
    }),
    [tree],
  );

  return { rows, loaded: root !== null && snapshot.children.has(root), error: snapshot.error, ...actions };
}
