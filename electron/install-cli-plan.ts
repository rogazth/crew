// Where "Install `crew` Command…" puts its link, worked out without touching
// the disk so it can be tested. install-cli.ts does the touching.

import path from "node:path";

// Around $PATH, so whatever a login shell's rc files print is skipped. The
// same trick as crates/crew-core/src/shell_path.rs.
export const PATH_MARKER = "__CREW_PATH__";

export const PATH_SCRIPT = `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`;

export function parseMarkedPath(out: string): string[] | null {
  const start = out.indexOf(PATH_MARKER);
  if (start < 0) return null;
  const from = start + PATH_MARKER.length;
  const end = out.indexOf(PATH_MARKER, from);
  if (end < 0) return null;
  const dirs = out.slice(from, end).split(":").filter(Boolean);
  return dirs.length > 0 ? dirs : null;
}

export const SYSTEM_BIN = "/usr/local/bin";

// ~/.local/bin when the user's shell already looks there, which asks for no
// password and touches nothing outside their home; /usr/local/bin otherwise,
// which every macOS shell has on its PATH.
export function chooseDir(pathDirs: readonly string[], home: string): string {
  const local = path.join(home, ".local/bin");
  const onPath = pathDirs.some((dir) => path.resolve(dir) === local);
  return onPath ? local : SYSTEM_BIN;
}

export function onPath(pathDirs: readonly string[], dir: string): boolean {
  return pathDirs.some((entry) => path.resolve(entry) === path.resolve(dir));
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// One `do shell script` behind macOS's own password prompt: the app never
// sees the password, and nothing else runs as root.
export function adminScript(source: string, link: string): string {
  const command = `mkdir -p ${shellQuote(path.dirname(link))} && ln -sfn ${shellQuote(source)} ${shellQuote(link)}`;
  return `do shell script ${appleScriptString(command)} with administrator privileges`;
}

// What is at the link's path now: nothing, the link this would make, some
// other link, or a file of the user's that is not Crew's to overwrite
// unasked.
export type Existing = "none" | "ours" | "other-link" | "file";

export function classify(entry: { isSymbolicLink: boolean; target: string | null } | null, source: string): Existing {
  if (!entry) return "none";
  if (!entry.isSymbolicLink) return "file";
  return entry.target && path.resolve(entry.target) === path.resolve(source) ? "ours" : "other-link";
}
