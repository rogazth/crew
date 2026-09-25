import { sameUrlKey } from "./suggest";
import { isLocalAddress, isWebUrl, resolveAddress } from "./url";

/** What the tab launcher offers for a query that reads as an address. */
export type LauncherAddress = {
  url: string;
  /** What was typed, without the scheme: `Open localhost:3200`. */
  label: string;
  /** On top, so Enter opens it; otherwise it heads the pages below the sessions. */
  lead: boolean;
};

/**
 * Only an address gets a row: a search would show up for every query typed
 * into a launcher of agents and sessions. `notes.md` also reads as a host, so
 * a bare dotted name only leads while nothing else matches; a scheme, a port,
 * a path or a local host is unmistakable.
 * `contested`: an action or a session also matches the query.
 */
export function launcherAddress(query: string, contested: boolean): LauncherAddress | null {
  const text = query.trim();
  const address = resolveAddress(text);
  if (address.kind !== "url" || !isWebUrl(address.url)) return null;
  const certain = /^https?:\/\//i.test(text) || /[:/]/.test(text) || isLocalAddress(text);
  return {
    url: address.url,
    label: text.replace(/^https?:\/\//i, ""),
    lead: certain || !contested,
  };
}

/** History under the address row, without the page that row already opens. */
export function launcherPages<T extends { url: string }>(
  address: LauncherAddress | null,
  history: readonly T[],
  limit: number,
): T[] {
  const key = address ? sameUrlKey(address.url) : null;
  return history.filter((entry) => key === null || sameUrlKey(entry.url) !== key).slice(0, limit);
}
