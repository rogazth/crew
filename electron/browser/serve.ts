/**
 * Which file a preview URL names, as pure decisions. files.ts wires them to
 * Electron; everything here refuses what it cannot place inside the root.
 */

import path from "node:path";
import { FILE_SCHEME } from "../../src/lib/browser/files";

/**
 * The file under `root` that a URL's path names, or null. A hidden segment is
 * refused, which also keeps `..` out: a page may read the worktree it was
 * opened from, but never its .env, .git or anything above it.
 */
export function servedPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return null;
  return path.join(root, ...segments);
}

/** Whether `real` is `root` or lies under it, both already resolved through their symlinks. */
export function within(root: string, real: string): boolean {
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** The URL that serves `file` under the root `host` stands for, or null when the file is not under it. */
export function urlFor(host: string, root: string, file: string): string | null {
  if (!path.isAbsolute(root) || !path.isAbsolute(file)) return null;
  const relative = path.relative(root, file);
  if (relative === "" || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return null;
  const encoded = relative.split(path.sep).map(encodeURIComponent).join("/");
  return `${FILE_SCHEME}://${host}/${encoded}`;
}
