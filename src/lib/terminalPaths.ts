import { homeDir } from "./host";

/** Everything else would be re-read by the shell, so it travels quoted. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quotePath(path: string): string {
  if (BARE.test(path)) return path;
  return `'${path.split("'").join(`'\\''`)}'`;
}

export function quotePaths(paths: string[]): string {
  return paths.map(quotePath).join(" ");
}

export type PathHit = {
  /** What gets underlined, `:line` included. */
  text: string;
  /** 0-based offset in the line. */
  start: number;
  /** The same span with any `:line:col` suffix removed. */
  path: string;
};

const SEGMENT = "[\\w.@%+=~-]+";
const CANDIDATE = new RegExp(
  `(?:~/|\\.{1,2}/|/)?(?:${SEGMENT}/)+${SEGMENT}(?::\\d+(?::\\d+)?)?`,
  "g",
);

/** Trailing prose punctuation a path never ends with. */
const TRAILING = /[.,;:!?)\]}>]+$/;

export function findPaths(line: string): PathHit[] {
  const hits: PathHit[] = [];
  for (const match of line.matchAll(CANDIDATE)) {
    const text = match[0].replace(TRAILING, "");
    if (!text.includes("/")) continue;
    hits.push({ text, start: match.index, path: text.replace(/:\d+(?::\d+)?$/, "") });
  }
  return hits;
}

export function resolvePath(raw: string, cwd: string, home: string): string {
  if (raw.startsWith("/")) return raw;
  const root = raw.startsWith("~/") ? home : cwd;
  if (!root) return raw;
  const rest = raw.startsWith("~/") ? raw.slice(2) : raw.replace(/^\.\//, "");
  return `${root.replace(/\/$/, "")}/${rest}`;
}

let home = "";
void homeDir()
  .then((dir) => {
    home = dir.replace(/\/$/, "");
  })
  .catch(() => {});

/** Empty until the first resolve lands; `~` paths simply stay unlinked until then. */
export const homePath = (): string => home;
