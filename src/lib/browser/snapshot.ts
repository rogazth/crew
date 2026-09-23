/**
 * A page's back/forward stack as crewd keeps it: read from the guest's
 * navigationHistory, stored as a row, handed back to navigationHistory.restore().
 * Everything on the way in and out passes through here, so a row stays small
 * and a malformed one never reaches Electron.
 */

export type NavEntry = { url: string; title: string; pageState?: string };
export type NavSnapshot = { entries: NavEntry[]; index: number };

const MAX_ENTRIES = 50;
const MAX_BYTES = 256 * 1024;

const encoder = new TextEncoder();

type Sized = { entry: NavEntry; size: number };

function isWeb(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function validIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/** A copy with only the fields restore() reads, so the size we measure is the size we store. */
function sized({ url, title, pageState }: NavEntry): Sized {
  const entry: NavEntry = pageState === undefined ? { url, title } : { url, title, pageState };
  return { entry, size: encoder.encode(JSON.stringify(entry)).length };
}

/** UTF-8 bytes of the entries as a JSON array: `[` + entries joined by `,` + `]`. */
function jsonBytes(list: readonly Sized[]): number {
  return list.reduce((sum, item) => sum + item.size + 1, 1);
}

/**
 * Trims a stack to what is worth a row: web pages only (the initial
 * about:blank is nothing to go back to), at most `maxEntries` around the
 * active one, and at most `maxBytes` of entries JSON, the column crewd stores.
 * Null when there is nothing to restore.
 */
export function capSnapshot(
  s: NavSnapshot,
  { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }: { maxEntries?: number; maxBytes?: number } = {},
): NavSnapshot | null {
  const active = s.entries[s.index];
  if (!validIndex(s.index, s.entries.length) || !active || !isWeb(active.url)) return null;
  const before = s.entries.slice(0, s.index).filter((e) => isWeb(e.url));
  const after = s.entries.slice(s.index + 1).filter((e) => isWeb(e.url));

  // Split the room around the active entry. Back is where people go, so it
  // gets the odd slot, and either side takes what the other cannot use.
  const room = Math.max(0, maxEntries - 1);
  let ahead = Math.min(after.length, Math.floor(room / 2));
  const behind = Math.min(before.length, room - ahead);
  ahead = Math.min(after.length, room - behind);
  const list = [...before.slice(before.length - behind), active, ...after.slice(0, ahead)].map(sized);
  let index = behind;

  // pageState (scroll, form state) is the bulk and the least missed: oldest first, the active page's last.
  const order = [...list.keys()].filter((i) => i !== index).concat(index);
  for (const i of order) {
    if (jsonBytes(list) <= maxBytes) break;
    const item = list[i];
    if (item?.entry.pageState !== undefined) {
      list[i] = sized({ url: item.entry.url, title: item.entry.title });
    }
  }
  // Then whole entries, farthest from the active one first; forward goes first on a tie.
  while (jsonBytes(list) > maxBytes && list.length > 1) {
    if (list.length - 1 - index >= index) {
      list.pop();
    } else {
      list.shift();
      index -= 1;
    }
  }
  // A single entry over budget is a URL too long to store.
  if (jsonBytes(list) > maxBytes) return null;
  return { entries: list.map((item) => item.entry), index };
}

function navEntry(value: unknown): NavEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { url, title, pageState } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof title !== "string") return null;
  if (pageState === undefined) return { url, title };
  return typeof pageState === "string" ? { url, title, pageState } : null;
}

/** Reads a stored row back. The row is untrusted input, so any malformed part rejects all of it. */
export function parseSnapshot(entriesJson: string, index: number): NavSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(entriesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || !validIndex(index, raw.length)) return null;
  const entries: NavEntry[] = [];
  for (const item of raw) {
    const entry = navEntry(item);
    if (!entry) return null;
    entries.push(entry);
  }
  return { entries, index };
}
