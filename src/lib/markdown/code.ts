import { highlightTokens, resolveLang, type CodeToken } from "../shiki";

/**
 * Colors for fenced code, from the same shiki grammars and themes as the chat.
 * Highlighting is async, so the preview asks, paints plain, and repaints when
 * `onHighlighted` fires. A block being typed in keeps its last colors until
 * the new ones land, so it never flashes plain between keystrokes.
 */

const MAX_CACHED = 200;
const cache = new Map<string, CodeToken[] | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
/** The last colors per block start, for a block whose text just changed. */
const lastAt = new Map<number, CodeToken[]>();

export function onHighlighted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tokens for this code, or the block's previous ones while they load. */
export function codeTokens(code: string, info: string, blockStart: number): CodeToken[] | null {
  const lang = resolveLang(info.trim().split(/\s/)[0]);
  if (!lang) return null;
  const key = `${lang}\0${code}`;
  if (cache.has(key)) {
    const tokens = cache.get(key)!;
    // Touch for LRU order.
    cache.delete(key);
    cache.set(key, tokens);
    if (tokens) {
      if (lastAt.size > 500) lastAt.clear();
      lastAt.set(blockStart, tokens);
    }
    return tokens;
  }
  if (!pending.has(key)) {
    pending.add(key);
    void highlightTokens(code, lang)
      .catch(() => null)
      .then((tokens) => {
        pending.delete(key);
        cache.set(key, tokens);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        for (const listener of listeners) listener();
      });
  }
  const stale = lastAt.get(blockStart);
  return stale ? stale.filter((t) => t.offset + t.length <= code.length) : null;
}
