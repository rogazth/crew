import type { Address } from "./url";

export type Suggestion =
  | { kind: "go"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "history"; url: string; label: string; title: string };

const LIMIT = 8;

/** The address bar's dropdown: what Enter would do, then history in the daemon's order. */
export function buildSuggestions(
  input: string,
  address: Address,
  history: readonly { url: string; title: string }[],
  limit: number = LIMIT,
): Suggestion[] {
  const top = input.trim() ? action(address) : null;
  const key = top ? sameUrlKey(top.url) : null;
  const rows: Suggestion[] = top ? [top] : [];
  for (const entry of history) {
    if (rows.length >= limit) break;
    if (key !== null && sameUrlKey(entry.url) === key) continue;
    const label = entry.title.trim() ? entry.title : entry.url;
    rows.push({ kind: "history", url: entry.url, label, title: entry.title });
  }
  return rows.slice(0, Math.max(0, limit));
}

function action(address: Address): Suggestion | null {
  if (address.kind === "url") return { kind: "go", url: address.url, label: address.url };
  if (address.kind === "search") return { kind: "search", url: address.url, label: address.query };
  return null;
}

/** What was typed (`https://EXAMPLE.com`) and what history holds
 *  (`https://example.com/`) are the same page. */
export function sameUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const href = parsed.href;
    return parsed.pathname === "/" && !parsed.search && href.endsWith("/") ? href.slice(0, -1) : href;
  } catch {
    return url.split("#")[0] ?? url;
  }
}
