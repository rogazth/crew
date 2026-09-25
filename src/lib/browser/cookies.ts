import type { CookieSource } from "../protocol";

/** "Chrome — Work": the browser, then the name its user gave the profile. */
export function cookieSourceLabel(source: CookieSource): string {
  return source.profile ? `${source.browser} — ${source.profile}` : source.browser;
}

/** What an import did, as one or two sentences. `left` is every cookie that didn't make it. */
export function importSummary(imported: number, left: number): string {
  const count = `${imported.toLocaleString("en-US")} cookie${imported === 1 ? "" : "s"}`;
  const rest = left > 0 ? ` ${left.toLocaleString("en-US")} couldn't be brought over: expired, bound to Google, or unreadable.` : "";
  return `Imported ${count}.${rest}`;
}
