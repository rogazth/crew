/**
 * How pages see the browser they run in, as pure functions. It goes by its own
 * name, Electron's token included: Cloudflare's Turnstile fails a browser that
 * drops that token and never lets the sign-in behind it through. Google's
 * sign-in is the exception, since it refuses embedded Chromium outright.
 * guests.ts wires these to the sessions and the pages.
 */

/** Google's sign-in pages, the only ones that get another browser's name. */
const SIGN_IN_HOSTS = new Set(["accounts.google.com"]);

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

type Headers = Record<string, string>;

/**
 * The headers one request goes out with: as they are, except on Google's
 * sign-in, where the request is Firefox's and has no client hints.
 */
export function outgoingHeaders(headers: Headers, url: string): Headers {
  if (!isGoogleSignIn(url)) return headers;
  const next: Headers = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key.startsWith("sec-ch-ua")) continue;
    next[name] = key === "user-agent" ? firefoxUserAgent() : value;
  }
  return next;
}
