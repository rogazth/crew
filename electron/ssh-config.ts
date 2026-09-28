// The user's own ~/.ssh/config: the Hosts it names, and what `ssh -G` makes of
// each. Crew never reads the options itself; it asks ssh, so Match, Include,
// ProxyJump and the rest mean exactly what they mean in a terminal.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SshHost } from "../src/lib/remotes.ts";

const exec = promisify(execFile);

/** What ssh will do for a destination. `proxied` means it does not dial `hostname` itself. */
export type Resolved = { hostname: string; port: number; user: string; proxied: boolean };

/** The Host names a config file declares, patterns and negations left out, in file order. */
export function hostAliases(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^host(?:\s+|\s*=\s*)(.+)$/i.exec(line);
    if (!match?.[1]) continue;
    for (const name of match[1].split(/\s+/)) {
      if (!name || /[*?!]/.test(name) || names.includes(name)) continue;
      names.push(name);
    }
  }
  return names;
}

/** `Include` lines, resolved against ~/.ssh the way ssh does; globs are left to `ssh -G` and skipped here. */
export function includes(text: string, home: string): string[] {
  const files: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^include(?:\s+|\s*=\s*)(.+)$/i.exec(line);
    if (!match?.[1]) continue;
    for (const item of match[1].split(/\s+/)) {
      if (!item || /[*?[]/.test(item)) continue;
      const expanded = item.startsWith("~/") ? path.join(home, item.slice(2)) : item;
      files.push(path.isAbsolute(expanded) ? expanded : path.join(home, ".ssh", expanded));
    }
  }
  return files;
}

/** `ssh -G` output into the few options Crew shows. */
export function parseResolved(text: string): Resolved {
  const options = new Map<string, string>();
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    if (!options.has(key)) options.set(key, line.slice(space + 1).trim());
  }
  const jump = options.get("proxyjump") ?? "none";
  const command = options.get("proxycommand") ?? "none";
  return {
    hostname: options.get("hostname") ?? "",
    port: Number(options.get("port")) || 22,
    user: options.get("user") ?? "",
    proxied: jump !== "none" || command !== "none",
  };
}

/** What `ssh [-l user] destination` would connect to, per the user's config. */
export async function resolveSsh(destination: string, user?: string): Promise<Resolved> {
  const args = ["-G", ...(user ? ["-l", user] : []), "--", destination];
  const { stdout } = await exec("ssh", args, { timeout: 5_000 });
  return parseResolved(stdout);
}

/** Every Host the user's config names, each as ssh resolves it. */
export async function sshHosts(): Promise<SshHost[]> {
  const home = homedir();
  const seen = new Set<string>();
  const aliases: string[] = [];
  const queue = [path.join(home, ".ssh", "config")];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8").catch(() => "");
    for (const alias of hostAliases(text)) if (!aliases.includes(alias)) aliases.push(alias);
    queue.push(...includes(text, home));
  }
  const rows = await Promise.all(
    aliases.map(async (alias): Promise<SshHost | null> => {
      try {
        const resolved = await resolveSsh(alias);
        return { alias, hostname: resolved.hostname, user: resolved.user, port: resolved.port };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is SshHost => row !== null);
}
