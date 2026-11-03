// Connectors' logos, kept on disk like an HTTP cache: the last answer is
// served at once, and one older than a day is asked again in the background,
// conditionally, so a page of logos opens without waiting on a dozen hosts.
// The window loads them as `crew-icon://icon/?u=<url>`; only this file goes
// out for them, so the window's policy stays closed to the hosts.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { iconTarget } from "../src/lib/icons";

/** What a logo's answer was, beside its bytes. */
type Meta = {
  url: string;
  type: string | null;
  etag: string | null;
  lastModified: string | null;
  checkedAt: number;
  /** The host said there is none (4xx, or not an image): asked again only once stale. */
  missing: boolean;
};

/** How long an answer is taken as it is before it is asked again. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
/** A logo is small; anything bigger is not one. */
export const MAX_BYTES = 1 << 20;
const TIMEOUT_MS = 10_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export type IconCache = { serve(request: Request): Promise<Response> };

const notFound = () => new Response(null, { status: 404 });

export function iconCache({ dir, fetch, now = Date.now }: { dir: string; fetch: Fetch; now?: () => number }): IconCache {
  const asking = new Map<string, Promise<Meta | null>>();
  const files = (url: string) => {
    const key = createHash("sha256").update(url).digest("hex");
    return { meta: path.join(dir, `${key}.json`), body: path.join(dir, `${key}.bin`) };
  };

  async function read(url: string): Promise<{ meta: Meta; body: Buffer | null } | null> {
    const at = files(url);
    try {
      const meta = JSON.parse(await readFile(at.meta, "utf8")) as Meta;
      if (meta.url !== url) return null;
      return { meta, body: meta.missing ? null : await readFile(at.body) };
    } catch {
      return null;
    }
  }

  /** Written whole through a temporary file, so a reader never sees half of one. */
  async function put(file: string, data: string | Uint8Array) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  /** Asks the host, conditionally when there is an answer to keep; one ask per logo at a time. */
  function ask(url: string, known: Meta | null): Promise<Meta | null> {
    const pending = asking.get(url);
    if (pending) return pending;
    const work = (async (): Promise<Meta | null> => {
      const headers: Record<string, string> = {};
      if (known && !known.missing) {
        if (known.etag) headers["if-none-match"] = known.etag;
        if (known.lastModified) headers["if-modified-since"] = known.lastModified;
      }
      let res: Response;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        // Offline or slow: what is kept stays, and nothing new is learned.
        return known;
      }
      const at = files(url);
      await mkdir(dir, { recursive: true });
      if (res.status === 304 && known) {
        const meta = { ...known, checkedAt: now() };
        await put(at.meta, JSON.stringify(meta));
        return meta;
      }
      const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
      const length = Number(res.headers.get("content-length") ?? 0);
      if (res.ok && type?.startsWith("image/") && length <= MAX_BYTES) {
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length <= MAX_BYTES) {
          const meta: Meta = {
            url,
            type,
            etag: res.headers.get("etag"),
            lastModified: res.headers.get("last-modified"),
            checkedAt: now(),
            missing: false,
          };
          await put(at.body, body);
          await put(at.meta, JSON.stringify(meta));
          return meta;
        }
      }
      // A server error may pass; a logo kept stays until the host says it is gone.
      if (res.status >= 500 && known) return known;
      const meta: Meta = { url, type: null, etag: null, lastModified: null, checkedAt: now(), missing: true };
      await put(at.meta, JSON.stringify(meta));
      return meta;
    })().finally(() => asking.delete(url));
    asking.set(url, work);
    return work;
  }

  const answer = (meta: Meta, body: Buffer) =>
    new Response(new Uint8Array(body), { headers: { "content-type": meta.type ?? "application/octet-stream", "cache-control": "no-store" } });

  return {
    async serve(request) {
      const url = iconTarget(request.url);
      if (!url) return notFound();
      const kept = await read(url);
      if (kept) {
        const stale = now() - kept.meta.checkedAt > FRESH_MS;
        if (!stale || kept.body) {
          if (stale) void ask(url, kept.meta).catch(() => {});
          return kept.body ? answer(kept.meta, kept.body) : notFound();
        }
      }
      const meta = await ask(url, kept?.meta ?? null).catch(() => null);
      if (!meta || meta.missing) return notFound();
      const fresh = await read(url);
      return fresh?.body ? answer(fresh.meta, fresh.body) : notFound();
    },
  };
}
