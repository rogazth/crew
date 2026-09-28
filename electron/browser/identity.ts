/**
 * How pages see the browser they run in, as pure functions. Sites judge a
 * session by the browser that holds it: an agent naming Electron is turned
 * away, one that names Chrome but lacks Chrome's brand in its client hints
 * looks like a stolen cookie, and Google's sign-in refuses embedded Chromium
 * outright. guests.ts wires these to the sessions and the pages.
 */

/** Google's sign-in pages, the only ones that get another browser's name. */
const SIGN_IN_HOSTS = new Set(["accounts.google.com"]);

/** Chrome's own user agent: no Electron or Crew token, and the reduced version Chrome sends. */
export function chromeUserAgent(defaultUA: string): string {
  return defaultUA
    .replace(/\bElectron\/\S+/gi, "")
    .replace(/\bcrew\/\S+/gi, "")
    .replace(/\bChrome\/(\d+)(?:\.\d+){1,3}\b/, "Chrome/$1.0.0.0")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Firefox's user agent on this platform. Google lets Firefox sign in from
 * anywhere, and it has no client hints to contradict it.
 */
export function firefoxUserAgent(platform: string = process.platform): string {
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10.15"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}; rv:140.0) Gecko/20100101 Firefox/140.0`;
}

export function isGoogleSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && SIGN_IN_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * A `sec-ch-ua` style brand list with Google Chrome in it, next to Chromium,
 * the way Chrome sends it. Chromium's own entries (and their GREASE brand)
 * stay as they were.
 */
export function withChromeBrand(list: string, version: string): string {
  if (/"Google Chrome"/.test(list)) return list;
  const brand = `"Google Chrome";v="${version}"`;
  const trimmed = list.trim();
  return trimmed ? `${trimmed}, ${brand}` : brand;
}

type Headers = Record<string, string>;

/**
 * The headers one request goes out with. Everywhere, the client hints name
 * Chrome; on Google's sign-in the request is Firefox's, so the hints go.
 */
export function outgoingHeaders(headers: Headers, url: string, chrome: { major: string; full: string }): Headers {
  const next: Headers = {};
  const signIn = isGoogleSignIn(url);
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (signIn && key.startsWith("sec-ch-ua")) continue;
    if (key === "sec-ch-ua") next[name] = withChromeBrand(value, chrome.major);
    else if (key === "sec-ch-ua-full-version-list") next[name] = withChromeBrand(value, chrome.full);
    else if (signIn && key === "user-agent") next[name] = firefoxUserAgent();
    else next[name] = value;
  }
  return next;
}
