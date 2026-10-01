import type { FolderEntry } from "./protocol";

/** One line of the explorer: an entry at its depth, folders with their state. */
export type TreeRow = {
  entry: FolderEntry;
  depth: number;
  expanded: boolean;
  /** Open, with its entries still on the way. */
  loading: boolean;
};

/**
 * The rows on screen: `root`'s entries, and inside each open folder its own,
 * as far as they have loaded. Folders are listed by the daemon, folders first.
 */
export function visibleRows(
  root: string,
  children: ReadonlyMap<string, FolderEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      const open = entry.dir && expanded.has(entry.path);
      rows.push({ entry, depth, expanded: open, loading: open && !children.has(entry.path) });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** The folders between `root` and `path`, outermost first; empty when `path` is not inside it. */
export function foldersTo(root: string, path: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return [];
  const parts = path.slice(prefix.length).split("/").slice(0, -1);
  return parts.map((_, index) => prefix + parts.slice(0, index + 1).join("/"));
}

/** Where `path` sits under `root`, as ⌘P and the tab strip spell it. */
export function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Same entries, in the same order and state: a refresh that changed nothing keeps the old list. */
export function sameEntries(a: readonly FolderEntry[] | undefined, b: readonly FolderEntry[]): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index]!;
      return entry.path === other.path && entry.dir === other.dir && entry.ignored === other.ignored;
    })
  );
}
