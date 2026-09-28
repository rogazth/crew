/**
 * What a page may use on this Mac, and what the person decided about it, as
 * pure decisions. Main answers Chromium with them; the window asks and keeps
 * the answers. Free of DOM and Electron, since both sides import it.
 */

/** What a site can be allowed or blocked, one prompt row each. */
export type SitePermission = "camera" | "microphone" | "notifications" | "geolocation" | "clipboard-read";

export type SiteDecision = "allow" | "block";

/** Decisions by origin ("https://meet.google.com"), then by permission. */
export type SitePermissions = Record<string, Partial<Record<SitePermission, SiteDecision>>>;

export const SITE_PERMISSIONS: readonly SitePermission[] = [
  "camera",
  "microphone",
  "notifications",
  "geolocation",
  "clipboard-read",
];

/** How each one reads: its name in lists, and what it lets a site do, in a prompt. */
export const PERMISSION_LABELS: Record<SitePermission, { name: string; does: string }> = {
  camera: { name: "Camera", does: "Use your camera" },
  microphone: { name: "Microphone", does: "Use your microphone" },
  notifications: { name: "Notifications", does: "Show notifications" },
  geolocation: { name: "Location", does: "Know your location" },
  "clipboard-read": { name: "Clipboard", does: "See text and images you copy" },
};

/** Chromium's own words for these, granted without asking: nothing they do reaches past the page. */
const ALWAYS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);

export function alwaysAllowed(permission: string): boolean {
  return ALWAYS.has(permission);
}

/**
 * The prompt rows a Chromium permission request stands for, or null for one
 * that is never offered (MIDI, USB, sensors...). A media request names the
 * kinds it wants; one that names none asks for both.
 */
export function permissionKinds(
  permission: string,
  media?: readonly string[] | string | undefined,
): SitePermission[] | null {
  switch (permission) {
    case "media": {
      const types = typeof media === "string" ? [media] : (media ?? []);
      const kinds: SitePermission[] = [];
      if (types.includes("video")) kinds.push("camera");
      if (types.includes("audio")) kinds.push("microphone");
      return kinds.length > 0 ? kinds : ["camera", "microphone"];
    }
    case "notifications":
      return ["notifications"];
    case "geolocation":
      return ["geolocation"];
    case "clipboard-read":
      return ["clipboard-read"];
    default:
      return null;
  }
}

/** Only a web page's origin can hold a decision; anything else has none to key it by. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export type Verdict = { answer: "allow" } | { answer: "block" } | { answer: "ask"; kinds: SitePermission[] };

/**
 * A block on any kind refuses the whole request, as Chromium would; every kind
 * allowed grants it; otherwise the person is asked about all of them at once,
 * so one prompt covers "camera and microphone".
 */
export function verdict(decisions: SitePermissions, origin: string, kinds: readonly SitePermission[]): Verdict {
  const site = decisions[origin] ?? {};
  if (kinds.some((kind) => site[kind] === "block")) return { answer: "block" };
  if (kinds.every((kind) => site[kind] === "allow")) return { answer: "allow" };
  return { answer: "ask", kinds: [...kinds] };
}

/** A copy with `kinds` set to `decision` for `origin`. */
export function decide(
  decisions: SitePermissions,
  origin: string,
  kinds: readonly SitePermission[],
  decision: SiteDecision,
): SitePermissions {
  const site = { ...decisions[origin] };
  for (const kind of kinds) site[kind] = decision;
  return { ...decisions, [origin]: site };
}

/** A copy without `origin`, or without one of its decisions. */
export function forget(decisions: SitePermissions, origin: string, kind?: SitePermission): SitePermissions {
  const next = { ...decisions };
  if (!kind) {
    delete next[origin];
    return next;
  }
  const site = { ...next[origin] };
  delete site[kind];
  if (Object.keys(site).length === 0) delete next[origin];
  else next[origin] = site;
  return next;
}

const MAX_SITES = 1000;

/** Anything malformed is dropped entry by entry: the map arrives from storage, or from the renderer. */
export function parseSitePermissions(value: unknown): SitePermissions {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: SitePermissions = {};
  for (const [origin, site] of Object.entries(raw).slice(0, MAX_SITES)) {
    if (originOf(origin) !== origin || typeof site !== "object" || site === null) continue;
    const kept: Partial<Record<SitePermission, SiteDecision>> = {};
    for (const kind of SITE_PERMISSIONS) {
      const decision = (site as Record<string, unknown>)[kind];
      if (decision === "allow" || decision === "block") kept[kind] = decision;
    }
    if (Object.keys(kept).length > 0) out[origin] = kept;
  }
  return out;
}

/** Schemes a page may never hand to another app: they reach files, script, or the browser itself. */
const NEVER_EXTERNAL = new Set([
  "http:",
  "https:",
  "about:",
  "blob:",
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "javascript:",
  "view-source:",
  "ws:",
  "wss:",
]);

/** An app's scheme: letters first, then letters, digits, `+`, `-` or `.`. */
const SCHEME = /^[a-z][a-z0-9+.-]*:$/;

/**
 * Whether a link may be offered to the app that handles its scheme (zoommtg:,
 * slack:, vscode:). Crew's own schemes are named by the caller, since they
 * change with the build. mailto: is not here: it goes to the mail app unasked.
 */
export function externalScheme(url: string, own: readonly string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!SCHEME.test(scheme) || scheme === "mailto:" || NEVER_EXTERNAL.has(scheme)) return null;
  if (own.some((name) => `${name.toLowerCase().replace(/:$/, "")}:` === scheme)) return null;
  return scheme.slice(0, -1);
}
