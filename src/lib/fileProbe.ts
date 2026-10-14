import { pathIsFile } from "./api";

/**
 * Whether a path an agent named is a file, asked of the daemon at most once
 * per path: a chat of thousands of messages names the same files over and
 * over. A miss is asked again only after a while, when the chat shows it
 * again, since an agent often names a file before it writes it.
 */
const MISS_TTL_MS = 30_000;
/** At most this many asks in flight; the rest wait their turn. */
const CONCURRENCY = 4;

type Entry = { found: boolean; at: number } | { pending: Promise<boolean> };

const cache = new Map<string, Entry>();
const queue: Array<() => void> = [];
let running = 0;

function pump() {
  while (running < CONCURRENCY && queue.length > 0) {
    running += 1;
    queue.shift()!();
  }
}

function ask(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push(() => {
      pathIsFile(path)
        .then(resolve, () => resolve(false))
        .finally(() => {
          running -= 1;
          pump();
        });
    });
    pump();
  });
}

/** What is known of `path` without asking: true, false, or undefined when it has to be asked. */
export function knownFile(path: string, now = Date.now()): boolean | undefined {
  const entry = cache.get(path);
  if (!entry || "pending" in entry) return undefined;
  if (!entry.found && now - entry.at > MISS_TTL_MS) return undefined;
  return entry.found;
}

/** Whether `path` is a file; one ask per path however many callers wait on it. */
export function isFile(path: string): Promise<boolean> {
  const known = knownFile(path);
  if (known !== undefined) return Promise.resolve(known);
  const entry = cache.get(path);
  if (entry && "pending" in entry) return entry.pending;
  const pending = ask(path).then((found) => {
    cache.set(path, { found, at: Date.now() });
    return found;
  });
  cache.set(path, { pending });
  return pending;
}

/** The first of `candidates` known to be a file, without asking; undefined when one has to be asked. */
export function firstKnown(candidates: readonly string[], now = Date.now()): string | null | undefined {
  for (const path of candidates) {
    const known = knownFile(path, now);
    if (known === undefined) return undefined;
    if (known) return path;
  }
  return null;
}

/** The first of `candidates` that is a file, asked in order; null when none is. */
export async function firstFile(candidates: readonly string[]): Promise<string | null> {
  for (const path of candidates) {
    if (await isFile(path)) return path;
  }
  return null;
}

/** For tests. */
export function resetFileProbe() {
  cache.clear();
  queue.length = 0;
  running = 0;
}
