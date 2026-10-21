import { client } from "./client";
import { fuzzyMatch } from "./fuzzy";
import type { CommandCatalog, CommandEntry, CommandsChanged } from "./protocol";

/**
 * The `/` menu of each session (plan step 4, A6): what its CLI can run after a
 * slash, plus Crew's own actions. The daemon pushes `commands-changed` with
 * the whole catalog; this keeps the latest per session, read the first time a
 * view asks, and again when the picker opens or the socket comes back.
 */

type Listener = () => void;

const catalogs = new Map<string, CommandCatalog>();
/** Bumped by every catalog heard: a read that went out before one is older than it. */
const heard = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("commands-changed", (payload) => {
    const change = payload as CommandsChanged;
    set(change.sessionId, change.catalog);
  });
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void refreshCommands(id);
  });
}

function set(id: string, catalog: CommandCatalog) {
  heard.set(id, (heard.get(id) ?? 0) + 1);
  catalogs.set(id, catalog);
  for (const listener of listeners.get(id) ?? []) listener();
}

/** Asks the daemon for the catalog; it answers from its cache and reads again when that is stale. */
export async function refreshCommands(id: string): Promise<void> {
  const before = heard.get(id) ?? 0;
  try {
    const catalog = await client.request<CommandCatalog>("commands_list", { sessionId: id });
    if ((heard.get(id) ?? 0) === before) set(id, catalog);
  } catch {
    // A crewd that predates the menu has nothing to list.
  }
}

export function subscribeCommands(id: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
    void refreshCommands(id);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function readCommands(id: string): CommandCatalog | null {
  return catalogs.get(id) ?? null;
}

// ——— What the composer derives ————————————————————————————————————————————

/** What follows a slash in a name: `compact`, `plugin:skill`, `mcp__srv__x`, `v1.2`. */
const NAME = /[\w:.-]/;

/** `/compact` or `/writing-for-agents` in a draft: a word that starts with a slash, and ends where a word does. */
const TOKEN = /(^|\s)\/([\w:.-]+)(?=$|[\s,;!?)])/g;

export type Segment = { kind: "text"; text: string } | { kind: "token"; name: string; text: string };

/** Where a `/name` token sits in a draft, and the entry it names. */
type Found = { start: number; end: number; entry: CommandEntry };

/** The slash word being typed at the caret, if the caret sits inside one. */
export function slashAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const slash = before.lastIndexOf("/");
  if (slash < 0) return null;
  if (slash > 0 && !/\s/.test(before[slash - 1]!)) return null;
  const query = before.slice(slash + 1);
  if (/\s/.test(query)) return null;
  let end = cursor;
  while (end < text.length && NAME.test(text[end]!)) end += 1;
  return { start: slash, end, query };
}

/**
 * What the menu lists for a query. A provider's command only works as the
 * message's first word, so anywhere else the menu offers skills and Crew's
 * actions alone. The name and each alias are matched the way files are, and
 * with no query everything comes in the catalog's own order.
 */
export function searchCommands(entries: readonly CommandEntry[], query: string, atStart: boolean): CommandEntry[] {
  const offered = atStart ? entries : entries.filter((entry) => entry.kind !== "command");
  if (!query) return [...offered];
  const hits: Array<{ entry: CommandEntry; score: number }> = [];
  for (const entry of offered) {
    let best: number | null = null;
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      const hit = fuzzyMatch(query, name);
      if (hit && (best === null || hit.score > best)) best = hit.score;
    }
    if (best !== null) hits.push({ entry, score: best });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.map((hit) => hit.entry);
}

/** Whether the slash at `start` opens the message: only blanks come before it. */
export const opensMessage = (text: string, start: number) => text.slice(0, start).trim() === "";

/**
 * The tokens of a draft the daemon will act on: a skill anywhere, a provider's
 * command as the first word. Crew's actions are not among them, since one
 * runs when it is picked and leaves nothing in the text. An alias is the
 * entry it names.
 */
function tokensOf(text: string, entries: readonly CommandEntry[]): Found[] {
  const byName = new Map<string, CommandEntry>();
  for (const entry of entries) {
    if (entry.kind === "crew") continue;
    for (const name of [entry.name, ...(entry.aliases ?? [])]) if (!byName.has(name)) byName.set(name, entry);
  }
  const found: Found[] = [];
  for (const match of text.matchAll(TOKEN)) {
    // A sentence can end on the name: "use /writing-for-agents."
    const typed = match[2]!;
    const name = byName.has(typed) ? typed : typed.replace(/\.+$/, "");
    const entry = byName.get(name);
    const start = (match.index ?? 0) + match[1]!.length;
    if (!entry || (entry.kind === "command" && !opensMessage(text, start))) continue;
    found.push({ start, end: start + 1 + name.length, entry });
  }
  return found;
}

/** Text split into runs, so an overlay can paint the commands and skills it names. */
export function splitTokens(text: string, entries: readonly CommandEntry[]): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const { start, end, entry } of tokensOf(text, entries)) {
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "token", name: entry.name, text: text.slice(start, end) });
    last = end;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/**
 * What a message asks of the provider besides its words: the command it opens
 * with, and the skills it names, once each in the order they come.
 */
export function dispatchOf(text: string, entries: readonly CommandEntry[]): { command?: string; skills: string[] } {
  const skills: string[] = [];
  let command: string | undefined;
  for (const { entry } of tokensOf(text, entries)) {
    if (entry.kind === "command") command ??= entry.name;
    else if (!skills.includes(entry.name)) skills.push(entry.name);
  }
  return { ...(command ? { command } : {}), skills };
}

/** Replaces the slash word under the caret with the chosen entry; returns the new text and caret. */
export function completeSlash(
  text: string,
  cursor: number,
  entry: CommandEntry,
): { text: string; cursor: number } | null {
  const active = slashAt(text, cursor);
  if (!active) return null;
  // The space after it is the one already there, if the slash sat before a word.
  const spaced = text[active.end] === " ";
  const inserted = `/${entry.name} `;
  const next = text.slice(0, active.start) + inserted + text.slice(active.end + (spaced ? 1 : 0));
  return { text: next, cursor: active.start + inserted.length };
}

/** Takes the slash word under the caret out, and the space after it: what a Crew action leaves of itself. */
export function removeSlash(text: string, cursor: number): { text: string; cursor: number } | null {
  const active = slashAt(text, cursor);
  if (!active) return null;
  const end = text[active.end] === " " ? active.end + 1 : active.end;
  return { text: text.slice(0, active.start) + text.slice(end), cursor: active.start };
}
