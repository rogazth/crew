/** `/abs/a.ts`, `~/a.ts`, `./a.ts`, `src/a.ts`, `file:///abs/a.ts`: a link to a file, not the web. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const RELATIVE = /^(?:\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z0-9]{1,8}(?:[:#].*)?$/i;

/**
 * The file a markdown link points at, when it points at one. Agents link the
 * files they touched — codex writes `[math.js](/repo/src/math.js)`, often
 * with a line on the end (`:12`, `#L12`) — and a click should open it in
 * Crew, not hand a path to the browser. The line is dropped: a file tab opens
 * at the top.
 */
export function localPath(href: string | undefined): string | null {
  if (!href) return null;
  let path = href;
  if (/^file:\/\//i.test(path)) path = decodeURIComponent(path.replace(/^file:\/\//i, ""));
  else if (SCHEME.test(path) || path.startsWith("#") || path.startsWith("//")) return null;
  else if (!path.startsWith("/") && !path.startsWith("~/") && !RELATIVE.test(path)) return null;
  path = path.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/(?::\d+){1,2}$/, "");
  return path || null;
}

/**
 * `src/lib/tabs.ts`, `/tmp/out/shot.png`, `~/Downloads/x.pdf`: a path with an
 * extension and no spaces, inside the workspace or anywhere else on its machine.
 */
const PATH_LIKE = /^(?:~\/|\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z0-9]{1,8}$/i;

/** Whether inline code is a file's path, which the chat turns into a chip that opens it. */
export function isPathLike(text: string): boolean {
  return PATH_LIKE.test(text);
}

/** Inline code that may hold a path, and what makes one a folder's. */
const INLINE_CODE = /`([^`\n]+)`/g;
const DIR_LIKE = /^(?:~\/|\/|\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@.-]*\/?$/;
/** A message names a few folders; more than this is a listing, not context. */
const MAX_DIRS = 6;

/**
 * The folders a message names in inline code, in order: `/tmp/shots/`, or
 * the folder of a file it names in full (`/tmp/shots/a.png`). An agent names
 * the folder once and its files by name after it, so a bare name is looked
 * for in these too.
 */
export function namedDirs(text: string): string[] {
  if (!text.includes("`") || !text.includes("/")) return [];
  const dirs: string[] = [];
  for (const match of text.matchAll(INLINE_CODE)) {
    const code = match[1]!.trim();
    if (!code.includes("/") || !DIR_LIKE.test(code)) continue;
    const dir = isPathLike(code) ? code.slice(0, code.lastIndexOf("/") + 1) : code;
    const clean = dir.replace(/\/+$/, "");
    if (!clean || dirs.includes(clean)) continue;
    dirs.push(clean);
    if (dirs.length === MAX_DIRS) break;
  }
  return dirs;
}
