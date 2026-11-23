/**
 * How pages see the browser they run in, as pure functions. It goes as plain
 * Chromium, which it is: sites that parse the agent take Electron's token for
 * an old browser and turn it away (WhatsApp Web). The agent is the app's
 * fallback (main.ts), never a session's: a session's does not reach a frame of
 * another site or a service worker, and Cloudflare's Turnstile, which runs in
 * such a frame, fails a browser whose frames disagree. It claims no Google
 * Chrome brand and patches nothing in the page. Google's sign-in is the
 * exception, since it refuses embedded Chromium outright; guests.ts wires that
 * one to the sessions and the pages.
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

/**
 * The agent Chromium itself sends, built from Electron's default: its platform
 * and Chrome's major version, and nothing else, so the app's token and
 * Electron's are gone whatever they are called. An agent of another shape is
 * left as it is.
 */
export function chromiumUserAgent(defaultUA: string): string {
  const platform = /^Mozilla\/5\.0 \(([^()]+)\)/.exec(defaultUA)?.[1];
  const major = /(?:^| )Chrome\/(\d+)(?:\.\d+)*(?= |$)/.exec(defaultUA)?.[1];
  if (!platform || !major) return defaultUA;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
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
