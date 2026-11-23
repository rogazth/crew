import { unicodeHost, type Address } from "./url";

export type Suggestion =
  | { kind: "go"; url: string; label: string }
  | { kind: "search"; url: string; label: string }
  | { kind: "history"; url: string; label: string; title: string };

const LIMIT = 8;

/**
 * The address bar's dropdown: what Enter would do, then history in the
 * daemon's order. `completed` is the URL the bar completed what was typed to,
 * which Enter goes to instead.
 */
export function buildSuggestions(
  input: string,
  address: Address,
  history: readonly { url: string; title: string }[],
  limit: number = LIMIT,
  completed: string | null = null,
): Suggestion[] {
  const top = completed ? { kind: "go" as const, url: completed, label: completed } : input.trim() ? action(address) : null;
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

/** The rest of a visited address after what was typed, and where Enter then goes. */
export type InlineCompletion = { suffix: string; url: string };

/**
 * What the bar completes `typed` to, Chrome's way: the first visit, in the
 * daemon's order, whose address starts with it, with or without its scheme and
 * `www.`. While the text is still inside the host it completes to the host
 * alone, so Enter goes to the site rather than the page last read there.
 */
export function inlineCompletion(typed: string, history: readonly { url: string }[]): InlineCompletion | null {
  if (!typed || /\s/.test(typed)) return null;
  const lower = typed.toLowerCase();
  const visits = history.map((entry) => visitForms(entry.url)).filter((visit) => visit !== null);
  // A whole host as typed is where the person means to go, even if a longer one starts the same.
  if (visits.some((visit) => visit.hosts.some((host) => host.toLowerCase() === lower))) return null;
  for (const { hosts, rest, origin, href } of visits) {
    for (const host of hosts) {
      const stem = host.toLowerCase();
      if (stem.length > lower.length && stem.startsWith(lower)) return { suffix: host.slice(typed.length), url: `${origin}/` };
      const page = `${host}${rest}`;
      if (rest && stem.length < lower.length && page.length > typed.length && page.toLowerCase().startsWith(lower)) {
        return { suffix: page.slice(typed.length), url: href };
      }
    }
  }
  return null;
}

/** The spellings of a visit's host the bar completes from, and what follows the host. */
function visitForms(url: string): { hosts: string[]; rest: string; origin: string; href: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const port = parsed.port ? `:${parsed.port}` : "";
  const names = new Set([parsed.hostname, unicodeHost(parsed.hostname)]);
  for (const name of [...names]) if (/^www\./i.test(name)) names.add(name.slice(4));
  const hosts = [...names].flatMap((name) => [`${name}${port}`, `${parsed.protocol}//${name}${port}`]);
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  parsed.hash = "";
  return { hosts, rest, origin: parsed.origin, href: parsed.href };
}

/**
 * The row lit in the list, and what lit it. Only the arrows choose a row:
 * the pointer lights one to show it can be clicked, as Chrome does.
 */
export type Highlight = { at: number; by: "keys" | "pointer" } | null;

/** The row the arrows chose, which the bar shows and Enter opens; null when the pointer lit it, or nothing did. */
export function chosenRow(rows: readonly Suggestion[], highlight: Highlight): Suggestion | null {
  return highlight?.by === "keys" ? (rows[highlight.at] ?? null) : null;
}

/** What the bar reads: the chosen row's address (a search's words), else what was typed. */
export function barText(value: string, rows: readonly Suggestion[], highlight: Highlight): string {
  const row = chosenRow(rows, highlight);
  return row ? (row.kind === "search" ? row.label : row.url) : value;
}

/** An arrow from wherever the list is lit, the pointer's row included; -1 goes back to what was typed. */
export function stepHighlight(highlight: Highlight, step: 1 | -1, count: number): Highlight {
  const at = Math.max(-1, Math.min(count - 1, (highlight?.at ?? -1) + step));
  return at < 0 ? null : { at, by: "keys" };
}
