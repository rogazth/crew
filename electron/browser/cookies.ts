import type { Cookie, CookiesSetDetails, Session } from "electron";
import type { CookieSameSite, ImportedCookie } from "../../src/lib/protocol";

/** Far past what one profile holds; a longer list is not from the daemon. */
const MAX_COOKIES = 50_000;
const MAX_FIELD = 8192;
const SAME_SITE: readonly CookieSameSite[] = ["unspecified", "no_restriction", "lax", "strict"];
const HOST = /^\.?[a-z0-9.-]+$/i;

export type CookieImportResult = { imported: number; failed: number };

function text(value: unknown, max = MAX_FIELD): value is string {
  return typeof value === "string" && value.length <= max;
}

/**
 * What `cookies.set` needs for one imported cookie, or null for a malformed one:
 * the list arrives from the renderer, so nothing in it is trusted.
 */
export function cookieDetails(value: unknown): CookiesSetDetails | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Partial<ImportedCookie>;
  if (!text(c.host, 253) || !HOST.test(c.host) || !text(c.name) || !text(c.value) || !text(c.path)) return null;
  if (typeof c.secure !== "boolean" || typeof c.httpOnly !== "boolean") return null;
  if (!c.sameSite || !SAME_SITE.includes(c.sameSite)) return null;
  if (c.expires !== undefined && (typeof c.expires !== "number" || !Number.isFinite(c.expires))) return null;

  const hostOnly = !c.host.startsWith(".");
  // A __Host- cookie must have no Domain and path /, or Chromium refuses it.
  const hostPrefixed = c.name.startsWith("__Host-");
  const path = hostPrefixed || !c.path.startsWith("/") ? "/" : c.path;
  return {
    url: `${c.secure ? "https" : "http"}://${c.host.replace(/^\./, "")}${path}`,
    name: c.name,
    value: c.value,
    ...(hostOnly || hostPrefixed ? {} : { domain: c.host }),
    path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    ...(c.expires === undefined ? {} : { expirationDate: c.expires }),
  };
}

/** A cookie one session holds, as `cookies.set` writes it into another. */
export function copiedCookie(cookie: Cookie): CookiesSetDetails | null {
  const host = cookie.domain?.replace(/^\./, "");
  if (!host) return null;
  const path = cookie.path || "/";
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path,
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    ...(cookie.session || cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
}

/** Every cookie `from` holds, written into `to`. */
export async function copyCookies(from: Session, to: Session): Promise<void> {
  const all = await from.cookies.get({});
  await Promise.all(
    all.map((cookie) => {
      const details = copiedCookie(cookie);
      return details ? to.cookies.set(details).catch(() => {}) : undefined;
    }),
  );
  await to.cookies.flushStore();
}

/** Adds to what the session already has; a cookie with the same name, domain and path is replaced. */
export async function importCookies(ses: Session, list: unknown): Promise<CookieImportResult> {
  if (!Array.isArray(list) || list.length > MAX_COOKIES) return { imported: 0, failed: 0 };
  let imported = 0;
  let failed = 0;
  await Promise.all(
    list.map(async (item: unknown) => {
      const details = cookieDetails(item);
      if (!details) {
        failed++;
        return;
      }
      try {
        await ses.cookies.set(details);
        imported++;
      } catch {
        failed++;
      }
    }),
  );
  await ses.cookies.flushStore();
  return { imported, failed };
}
