/** What the address bar does with what was typed into it. */

export const DEFAULT_SEARCH = "https://www.google.com/search?q=%s";

export type Address =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string }
  | { kind: "empty" };

/**
 * Dev servers speak plain http: loopback, `*.localhost` (which resolves to
 * loopback), the private IPv4 ranges a phone or a VM on the LAN is reached
 * at, and `.local` mDNS names.
 */
const LOCAL =
  /^(?:(?:[a-z0-9-]+\.)*localhost|(?:[a-z0-9-]+\.)+local|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|0\.0\.0\.0|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const WEB_SCHEME = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `example.com:8080` also starts like a scheme; digits after the colon make it a port. */
const HOST_PORT = /^[^\s:/?#]+:\d+(?:[/?#]|$)/;
/** A dotted name whose last label is letters (or punycode), or an IPv4 address. */
const HOST =
  /^(?:(?:[\p{L}\p{M}\p{N}-]+\.)+(?:[\p{L}\p{M}]{2,}|xn--[a-z0-9-]+)|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

export function resolveAddress(input: string, searchTemplate: string = DEFAULT_SEARCH): Address {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  // Before anything that parses: `new URL("localhost:3000")` reads `localhost:` as the scheme.
  if (LOCAL.test(text)) return navigable(`http://${text}`) ?? search(text, searchTemplate);
  if (WEB_SCHEME.test(text)) {
    const href = parse(text)?.href;
    return href ? { kind: "url", url: href } : search(text, searchTemplate);
  }
  if (text === "about:blank") return { kind: "url", url: text };
  // javascript:, file:, mailto: and the rest never navigate from the bar.
  if (SCHEME.test(text) && !HOST_PORT.test(text)) return search(text, searchTemplate);
  if (/\s/.test(text)) return search(text, searchTemplate);
  if (HOST.test(text)) return navigable(`https://${text}`) ?? search(text, searchTemplate);
  return search(text, searchTemplate);
}

/** Keeps what was typed, so the suggestion row reads back the user's own spelling. */
function navigable(url: string): Address | null {
  return parse(url) ? { kind: "url", url } : null;
}

function search(query: string, template: string): Address {
  return { kind: "search", query, url: template.replace("%s", encodeURIComponent(query)) };
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A dev server or a LAN device, typed without a scheme. */
export function isLocalAddress(input: string): boolean {
  return LOCAL.test(input.trim());
}

export function isWebUrl(url: string): boolean {
  const protocol = parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

/** The blank page shows an empty bar, not `about:blank`. */
export function displayUrl(url: string): string {
  const parsed = parse(url);
  if (!parsed || (parsed.protocol === "about:" && parsed.pathname === "blank")) return "";
  return url;
}

/** A fragment-only change is the same document, so it is not another history visit. */
export function sameDocument(a: string, b: string): boolean {
  return withoutFragment(a) === withoutFragment(b);
}

function withoutFragment(url: string): string {
  const parsed = parse(url);
  if (!parsed) return url.split("#")[0] ?? url;
  parsed.hash = "";
  return parsed.href;
}
