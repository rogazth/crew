/**
 * What the embedded browser lets a page do, as pure decisions. guests.ts wires
 * them to Electron; everything here fails closed on anything it does not know.
 */

import { PARTITION, RESTORE_PREFIX } from "../../src/lib/browser/bridge";

// The window builds its webviews with these; one definition keeps the two sides agreeing.
export { PARTITION, RESTORE_PREFIX };

const RESTORE_TOKEN = /^[A-Za-z0-9-]{1,64}$/;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isWeb(url: URL | null): boolean {
  return url?.protocol === "http:" || url?.protocol === "https:";
}

/** about:blank with or without a fragment; not about:srcdoc, not about:blank?x. */
function isBlank(url: URL | null): boolean {
  return url?.protocol === "about:" && url.pathname === "blank" && url.search === "";
}

/**
 * Makes a guest's webPreferences safe whatever the webview element asked for:
 * no preload, no Node, isolated, sandboxed, same-origin enforced.
 */
export function hardenWebPreferences(prefs: Record<string, unknown>): void {
  delete prefs.preload;
  delete prefs.preloadURL;
  delete prefs.enableBlinkFeatures;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  // A page must not embed guests of its own: those would attach with none of these checks.
  prefs.webviewTag = false;
  // Blink's defaults: the element can switch features neither on nor off.
  prefs.disableBlinkFeatures = "";
}

/**
 * Whether a <webview> may attach: only in the browser partition, and only
 * starting blank or at a web page. A restore src yields its token.
 */
export function attachDecision(params: {
  src?: string;
  partition?: string;
}): { allow: false } | { allow: true; restoreToken: string | null } {
  if (params.partition !== PARTITION) return { allow: false };
  const src = params.src ?? "";
  if (src.startsWith(RESTORE_PREFIX)) {
    const token = src.slice(RESTORE_PREFIX.length);
    return RESTORE_TOKEN.test(token) ? { allow: true, restoreToken: token } : { allow: false };
  }
  const url = parse(src);
  if (src === "" || isBlank(url) || isWeb(url)) return { allow: true, restoreToken: null };
  return { allow: false };
}

export type NavigationVerdict = "allow" | "external" | "block";

/** Where a page may take itself: the web, or mail through the system. Never file:, javascript: or app schemes. */
export function navigationVerdict(url: string): NavigationVerdict {
  const parsed = parse(url);
  if (isWeb(parsed) || isBlank(parsed)) return "allow";
  if (parsed?.protocol === "mailto:") return "external";
  return "block";
}

export type PopupVerdict =
  | { action: "tab"; url: string; background: boolean }
  | { action: "window" }
  | { action: "external"; url: string }
  | { action: "deny" };

// innerWidth and innerHeight are the spec's aliases for width and height.
const POPUP_FEATURES = new Set(["width", "height", "innerwidth", "innerheight", "popup"]);

/** A window size or an explicit popup: the shape of a login flow that needs window.opener. */
function asksForPopup(features: string): boolean {
  return features
    .split(",")
    .some((feature) => POPUP_FEATURES.has((feature.split("=")[0] ?? "").trim().toLowerCase()));
}

/** What window.open and target=_blank become: a Crew tab, a real child window, the mail app, or nothing. */
export function popupVerdict(details: { url: string; disposition: string; features: string }): PopupVerdict {
  const url = parse(details.url);
  // Some logins open a sized blank popup first, then navigate it or post a form into it.
  if (isBlank(url) && details.disposition === "new-window" && asksForPopup(details.features)) {
    return { action: "window" };
  }
  if (!isWeb(url)) return url?.protocol === "mailto:" ? { action: "external", url: details.url } : { action: "deny" };
  switch (details.disposition) {
    case "new-window":
      return asksForPopup(details.features)
        ? { action: "window" }
        : { action: "tab", url: details.url, background: false };
    case "background-tab":
      return { action: "tab", url: details.url, background: true };
    case "foreground-tab":
    case "default":
    case "other":
      return { action: "tab", url: details.url, background: false };
    default:
      // save-to-disk, and whatever Chromium adds next.
      return { action: "deny" };
  }
}

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);

/** Camera, microphone, location, notifications, screen capture and the rest stay off. */
export function permissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local dev servers sign their own certificates; nothing else gets past a bad
 * one. The parsed hostname is compared whole, so localhost.evil.com and
 * 127.0.0.1.nip.io stay refused.
 */
export function certificateBypass(url: string): boolean {
  const parsed = parse(url);
  // wss: too, for the live-reload socket a dev server opens over the same certificate.
  const secure = parsed?.protocol === "https:" || parsed?.protocol === "wss:";
  return secure && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** A sliding window: the returned function says whether one more action fits now, and counts it if so. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now): () => boolean {
  let recent: number[] = [];
  return () => {
    const at = now();
    recent = recent.filter((t) => at - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(at);
    return true;
  };
}

/** Chromium's own user agent: some sites turn away agents that name Electron or the app. */
export function browserUserAgent(defaultUA: string): string {
  return defaultUA
    .replace(/\bElectron\/\S+/gi, "")
    .replace(/\bcrew\/\S+/gi, "")
    .replace(/ {2,}/g, " ")
    .trim();
}
