import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { iconSrc, iconTarget } from "../src/lib/icons";
import { FRESH_MS, iconCache, MAX_BYTES } from "./icons";

const LOGO = "https://notion.com/logo.png";
const png = (bytes: number[]) => new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", etag: '"v1"' } });

let dir: string;
let clock: number;
let asked: { url: string; headers: Record<string, string> }[];
let answers: (() => Response | Promise<Response>)[];

const cache = () =>
  iconCache({
    dir,
    now: () => clock,
    fetch: async (url, init) => {
      asked.push({ url, headers: init.headers });
      const next = answers.shift();
      if (!next) throw new Error("offline");
      return next();
    },
  });
const get = (c: ReturnType<typeof iconCache>, url = LOGO) => c.serve(new Request(iconSrc(url, true)));
const bytes = async (res: Response) => [...new Uint8Array(await res.arrayBuffer())];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), "crew-icons-")), "icons");
  clock = 1_000_000;
  asked = [];
  answers = [];
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

describe("iconTarget", () => {
  it("takes an http(s) logo back out of its crew-icon URL, and nothing else", () => {
    expect(iconTarget(iconSrc(LOGO, true))).toBe(LOGO);
    expect(iconTarget(iconSrc("file:///etc/passwd", true))).toBeNull();
    expect(iconTarget("https://notion.com/logo.png")).toBeNull();
    expect(iconSrc(LOGO, false)).toBe(LOGO);
  });
});

describe("iconCache", () => {
  it("asks once, then serves from disk, across restarts", async () => {
    answers.push(() => png([1, 2, 3]));
    const res = await get(cache());
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await bytes(res)).toEqual([1, 2, 3]);
    expect(await bytes(await get(cache()))).toEqual([1, 2, 3]);
    expect(asked).toHaveLength(1);
  });

  it("serves a stale logo at once and asks again in the background, conditionally", async () => {
    answers.push(() => png([1]));
    const c = cache();
    await get(c);
    clock += FRESH_MS + 1;
    answers.push(() => new Response(null, { status: 304 }));
    expect(await bytes(await get(c))).toEqual([1]);
    await settle();
    expect(asked[1]?.headers["if-none-match"]).toBe('"v1"');
    // The 304 made it fresh again: no third ask.
    await get(c);
    await settle();
    expect(asked).toHaveLength(2);
  });

  it("replaces a logo the host changed", async () => {
    answers.push(() => png([1]));
    const c = cache();
    await get(c);
    clock += FRESH_MS + 1;
    answers.push(() => png([2]));
    await get(c);
    await settle();
    expect(await bytes(await get(c))).toEqual([2]);
  });

  it("remembers a logo that is not there until it is stale", async () => {
    answers.push(() => new Response("nope", { status: 404 }));
    const c = cache();
    expect((await get(c)).status).toBe(404);
    expect((await get(c)).status).toBe(404);
    expect(asked).toHaveLength(1);
    clock += FRESH_MS + 1;
    answers.push(() => png([7]));
    expect(await bytes(await get(c))).toEqual([7]);
  });

  it("keeps what it has when the host is down or offline, and keeps nothing new from a miss offline", async () => {
    answers.push(() => png([1]));
    const c = cache();
    await get(c);
    clock += FRESH_MS + 1;
    answers.push(() => new Response(null, { status: 503 }));
    await get(c);
    await settle();
    expect(await bytes(await get(c))).toEqual([1]);
    expect((await get(c, "https://elsewhere.dev/x.png")).status).toBe(404);
    answers.push(() => png([9]));
    expect(await bytes(await get(c, "https://elsewhere.dev/x.png"))).toEqual([9]);
  });

  it("takes only images, and none too big", async () => {
    answers.push(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect((await get(cache())).status).toBe(404);
    answers.push(() => new Response(new Uint8Array(MAX_BYTES + 1), { headers: { "content-type": "image/png" } }));
    expect((await get(cache(), "https://big.dev/x.png")).status).toBe(404);
  });

  it("asks once for a logo many marks want at the same time", async () => {
    answers.push(() => png([1]));
    const c = cache();
    const all = await Promise.all([get(c), get(c), get(c)]);
    expect(asked).toHaveLength(1);
    for (const res of all) expect(await bytes(res)).toEqual([1]);
  });
});
