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
  // A file opens as a preview tab, served by Crew's own scheme: never through `file:` in a page.
  const file = fileHref(text);
  if (file) return { kind: "url", url: file };
  // javascript:, mailto: and the rest never navigate from the bar.
  if (SCHEME.test(text) && !HOST_PORT.test(text)) return search(text, searchTemplate);
  if (/\s/.test(text)) return search(text, searchTemplate);
  if (HOST.test(text)) return navigable(`https://${text}`) ?? search(text, searchTemplate);
  return search(text, searchTemplate);
}

/** Keeps what was typed, so the suggestion row reads back the user's own spelling. */
function navigable(url: string): Address | null {
  return parse(url) ? { kind: "url", url } : null;
}

/** A search for `query` even when it reads as an address: what a "Search the web" row opens. */
export function searchUrl(query: string, searchTemplate: string = DEFAULT_SEARCH): string {
  return search(query.trim(), searchTemplate).url;
}

function search(query: string, template: string): Extract<Address, { kind: "search" }> {
  return { kind: "search", query, url: template.replace("%s", encodeURIComponent(query)) };
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `file:///a/b.html` or a pasted `/a/b.html`: the file's URL, without query or fragment. */
function fileHref(text: string): string | null {
  const local = /^file:\/\//i.test(text) ? parse(text) : text.startsWith("/") && !text.startsWith("//") ? parse(`file://${text}`) : null;
  if (!local || local.protocol !== "file:" || (local.host !== "" && local.host !== "localhost")) return null;
  if (local.pathname === "/" || local.pathname.endsWith("/")) return null;
  return `file://${local.pathname}`;
}

/** The path a `file:` URL names, or null for anything else. */
export function filePathOf(url: string): string | null {
  const parsed = parse(url);
  if (parsed?.protocol !== "file:" || (parsed.host !== "" && parsed.host !== "localhost")) return null;
  try {
    return decodeURIComponent(parsed.pathname);
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

/**
 * The address as the bar shows it at rest, Chrome's way: the host to read,
 * then the rest, dimmer. No scheme, no `www.`, never the user name or password
 * a URL can carry before its host. A file reads as its folder, then its name.
 * Null for anything else, which the bar shows as it is.
 */
export type AddressParts = { kind: "host"; host: string; path: string } | { kind: "file"; folder: string; name: string };

export function addressParts(url: string): AddressParts | null {
  const parsed = parse(url);
  if (!parsed) return null;
  if (parsed.protocol === "file:") {
    const path = readablePath(parsed.pathname);
    const cut = path.lastIndexOf("/") + 1;
    return { kind: "file", folder: path.slice(0, cut), name: path.slice(cut) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  // "example.com/?q" keeps its slash: without it the query reads as part of the host.
  const path = rest && !rest.startsWith("/") ? `/${rest}` : rest;
  return { kind: "host", host: hostLabel(parsed), path: readablePath(path) };
}

/** `example.com:8080`, in Unicode when that can't pass for another site, without a leading `www.`. */
export function hostLabel(url: URL): string {
  const name = withoutWww(unicodeHost(url.hostname));
  return url.port ? `${name}:${url.port}` : name;
}

function withoutWww(host: string): string {
  return /^www\.[^.]+\..+/i.test(host) ? host.slice(4) : host;
}

/**
 * Percent escapes read back as text, except where the text would hide
 * something: a space, a control or a direction override stays escaped.
 */
function readablePath(path: string): string {
  try {
    const text = decodeURI(path);
    return /[\s\p{Cc}\p{Cf}]/u.test(text) ? path : text;
  } catch {
    return path;
  }
}

/**
 * The host in Unicode (`bücher.de`) when every label is safe to show that
 * way, else as it is (`xn--...`). One unsafe label keeps the whole host in
 * punycode, as Chrome does: a mixed or look-alike name must not pass for
 * another site.
 */
export function unicodeHost(hostname: string): string {
  if (!/(^|\.)xn--/i.test(hostname)) return hostname;
  const labels = hostname.split(".");
  const decoded: string[] = [];
  for (const label of labels) {
    if (!/^xn--/i.test(label)) {
      decoded.push(label);
      continue;
    }
    const text = punycodeDecode(label.slice(4).toLowerCase());
    // Empty or plain ASCII once decoded: not a name anyone registered in Unicode.
    if (!text || !/[^\p{ASCII}]/u.test(text)) return hostname;
    decoded.push(text);
  }
  const tld = scriptsOf(decoded.at(-1) ?? "");
  for (const label of decoded) if (!safeLabel(label, tld)) return hostname;
  return decoded.join(".");
}

/** Scripts that read alike and could spell a Latin name: shown only under a TLD in the same script. */
const LOOKALIKE = ["Cyrillic", "Greek"];
/** Scripts that mix in one label as a language does (Japanese, Korean), with Latin letters. */
const MIXES = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Hangul"]),
];
const SCRIPTS = [
  "Latin", "Cyrillic", "Greek", "Han", "Hiragana", "Katakana", "Hangul", "Arabic", "Hebrew",
  "Thai", "Devanagari", "Bengali", "Tamil", "Armenian", "Georgian", "Ethiopic",
].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const);

function scriptsOf(label: string): Set<string> | null {
  const found = new Set<string>();
  for (const char of label) {
    if (/[0-9-]/.test(char) || /\p{M}/u.test(char)) continue;
    if (!/\p{L}/u.test(char)) return null;
    const script = SCRIPTS.find(([, test]) => test.test(char))?.[0];
    if (!script) return null;
    found.add(script);
  }
  return found;
}

function safeLabel(label: string, tld: Set<string> | null): boolean {
  const scripts = scriptsOf(label);
  if (!scripts) return false;
  if (scripts.size > 1 && !MIXES.some((mix) => [...scripts].every((script) => mix.has(script)))) return false;
  for (const script of LOOKALIKE) if (scripts.has(script) && !tld?.has(script)) return false;
  return true;
}

/** RFC 3492, decoding only: the label after `xn--`, or null when it is not valid punycode. */
function punycodeDecode(input: string): string | null {
  const BASE = 36;
  const T_MIN = 1;
  const T_MAX = 26;
  const digit = (code: number) =>
    code >= 48 && code <= 57 ? code - 22 : code >= 97 && code <= 122 ? code - 97 : code >= 65 && code <= 90 ? code - 65 : -1;
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    for (; d > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) d = Math.floor(d / (BASE - T_MIN));
    return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + 38));
  };
  const out: number[] = [];
  const delimiter = input.lastIndexOf("-");
  for (let at = 0; at < delimiter; at++) {
    const code = input.charCodeAt(at);
    if (code >= 0x80) return null;
    out.push(code);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let at = delimiter >= 0 ? delimiter + 1 : 0; at < input.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (at >= input.length) return null;
      const d = digit(input.charCodeAt(at++));
      if (d < 0) return null;
      i += d * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/**
 * What the chip at the start of the bar says about the page. Chromium refuses
 * a bad certificate everywhere but a local dev server (see `certificateBypass`
 * in electron/browser/policy.ts), so a page that loaded over https anywhere
 * else had a valid one. Local covers loopback and the `*.localhost` names
 * that reach a workspace's machine.
 */
export type SiteSecurity = "secure" | "insecure" | "local" | "file" | "crew" | "none";

export function siteSecurity(url: string): SiteSecurity {
  if (!displayUrl(url)) return "none";
  const parsed = parse(url);
  if (!parsed) return "none";
  if (parsed.protocol === "file:") return "file";
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (isLoopbackHost(parsed.hostname)) return "local";
    return parsed.protocol === "https:" ? "secure" : "insecure";
  }
  if (parsed.protocol.startsWith("crew")) return "crew";
  return "none";
}

/** This Mac's loopback, or a `*.localhost` name, which Chromium never resolves anywhere else. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
