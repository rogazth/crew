/** `/abs/a.ts`, `./a.ts`, `src/a.ts`, `file:///abs/a.ts`: a link to a file, not the web. */
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
  else if (!path.startsWith("/") && !RELATIVE.test(path)) return null;
  path = path.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/(?::\d+){1,2}$/, "");
  return path || null;
}
