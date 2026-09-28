/** Paths on another machine, typed into ⌘O's folder field. Always POSIX: remotes are Linux. */

/** "~/code/sto" is code/ under home, filtered to names that start with "sto". */
export function splitTyped(raw: string, home: string): { dir: string; filter: string } {
  const slash = raw.lastIndexOf("/");
  const head = slash === -1 ? "" : raw.slice(0, slash + 1);
  const filter = slash === -1 ? raw.replace(/^~$/, "") : raw.slice(slash + 1);
  return { dir: resolveTyped(head, home), filter };
}

/** A typed folder as an absolute path: `~` and a bare name are under home. */
export function resolveTyped(typed: string, home: string): string {
  const text = typed.trim();
  if (text === "" || text === "~" || text === "~/") return normalize(home);
  if (text.startsWith("~/")) return normalize(`${home}/${text.slice(2)}`);
  if (text.startsWith("/")) return normalize(text);
  return normalize(`${home}/${text}`);
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function joinPath(dir: string, name: string): string {
  return normalize(`${dir}/${name}`);
}

export function parentOf(path: string): string {
  const trimmed = normalize(path);
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

export function leafOf(path: string): string {
  const trimmed = normalize(path);
  return trimmed === "/" ? "/" : (trimmed.split("/").pop() ?? trimmed);
}

/** Under home, as `~/…`; anywhere else, as it is. */
export function prettyPath(path: string, home: string): string {
  const root = normalize(home);
  if (root !== "/" && path === root) return "~";
  if (root !== "/" && path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
  return path;
}
