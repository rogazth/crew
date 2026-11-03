/**
 * Connectors' logos, through the app's cache (`electron/icons.ts`): the window
 * asks `crew-icon:` for a logo's URL and main answers from disk. Imported by
 * both sides, so it stays free of DOM and Electron.
 */

export const ICON_SCHEME = "crew-icon";

/** Where the window loads a logo from: the cache in the app, the URL itself elsewhere (the mock in a browser). */
export function iconSrc(url: string, cached: boolean): string {
  return cached ? `${ICON_SCHEME}://icon/?u=${encodeURIComponent(url)}` : url;
}

/** The logo's own URL from a `crew-icon:` one: http(s) only. */
export function iconTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${ICON_SCHEME}:`) return null;
    const target = new URL(parsed.searchParams.get("u") ?? "");
    return target.protocol === "https:" || target.protocol === "http:" ? target.href : null;
  } catch {
    return null;
  }
}
