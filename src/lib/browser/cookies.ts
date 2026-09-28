import type { CookieSource } from "../protocol";

/** "Chrome — Work": the browser, then the name its user gave the profile. */
export function cookieSourceLabel(source: CookieSource): string {
  return source.profile ? `${source.browser} — ${source.profile}` : source.browser;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What an import did, in a sentence or three. `left` is every cookie that
 * didn't make it for its own reasons; `google` the ones kept back because
 * Google binds them to the browser, which only a sign-in here replaces.
 */
export function importSummary(imported: number, left: number, google = 0): string {
  const parts = [`Imported ${count(imported)} cookie${imported === 1 ? "" : "s"}.`];
  if (left > 0) parts.push(`${count(left)} couldn't be brought over: expired or unreadable.`);
  if (google > 0) parts.push("Google and YouTube accounts stay where they are: sign in to Google here to use them.");
  return parts.join(" ");
}
