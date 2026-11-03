import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInOutcome } from "../../src/lib/browser/bridge";
import { LoopbackSignIns } from "./sign-in-loopback";

const STATE = "s7Hq2-xYz_0123456789";
const OTHER = "second-state-456789";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

/** A port nothing holds right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}

/** Whether the port takes connections: binding it again fails only while someone listens. */
async function held(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((done) => {
    probe.once("error", () => done(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(false)));
  });
}

/** One request with whatever Host it says, since fetch won't let a test forge it. */
function ask(port: number, path: string, options: { host?: string; method?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { Host: options.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("LoopbackSignIns", () => {
  let port: number;
  let redirectUri: string;
  let open: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  let signIns: LoopbackSignIns;
  let blocker: Server | null = null;

  const opened = () => vi.waitFor(() => expect(open).toHaveBeenCalled());
  const start = (state = STATE) => signIns.start({ state, authUrl: AUTH, redirectUri });

  beforeEach(async () => {
    port = await freePort();
    redirectUri = `http://127.0.0.1:${port}/callback`;
    open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    signIns = new LoopbackSignIns({ port, open });
  });

  afterEach(async () => {
    signIns.abort(STATE);
    signIns.abort(OTHER);
    if (blocker) await new Promise((done) => blocker!.close(done));
    blocker = null;
  });

  it("opens the page once it listens, and closes the port when the redirect comes", async () => {
    const outcome = start();
    await opened();
    expect(open).toHaveBeenCalledWith(AUTH);
    expect(await held(port)).toBe(true);
    const answer = await ask(port, `/callback?code=abc&state=${STATE}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("Go back to Crew");
    await expect(outcome).resolves.toEqual({ kind: "caught", url: `${redirectUri}?code=abc&state=${STATE}` });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("catches an error redirect too: the daemon reads it", async () => {
    const outcome = start();
    await opened();
    await ask(port, `/callback?error=access_denied&state=${STATE}`);
    await expect(outcome).resolves.toEqual({ kind: "caught", url: `${redirectUri}?error=access_denied&state=${STATE}` });
  });

  it("answers a wrong state with a harmless error and keeps waiting", async () => {
    let settled: SignInOutcome | null = null;
    const outcome = start().then((o) => (settled = o));
    await opened();
    for (const path of [`/callback?code=evil&state=other-state-123`, "/callback?code=evil", "/callback"]) {
      const answer = await ask(port, path);
      expect(answer.status).toBe(404);
      expect(answer.body).not.toContain("evil");
    }
    expect(settled).toBeNull();
    expect(await held(port)).toBe(true);
    await ask(port, `/callback?code=good&state=${STATE}`);
    await expect(outcome).resolves.toEqual({ kind: "caught", url: `${redirectUri}?code=good&state=${STATE}` });
  });

  it("answers another path, method or Host with an error, even with the right state", async () => {
    let settled: SignInOutcome | null = null;
    const outcome = start().then((o) => (settled = o));
    await opened();
    expect((await ask(port, "/favicon.ico")).status).toBe(404);
    expect((await ask(port, `/callback/more?state=${STATE}`)).status).toBe(404);
    expect((await ask(port, `/other?code=c&state=${STATE}`)).status).toBe(404);
    expect((await ask(port, `/callback?code=c&state=${STATE}`, { method: "POST" })).status).toBe(404);
    expect((await ask(port, `/callback?code=c&state=${STATE}`, { host: `evil.example:${port}` })).status).toBe(404);
    expect(settled).toBeNull();
    signIns.abort(STATE);
    await expect(outcome).resolves.toEqual({ kind: "closed" });
  });

  it("says so when the port is in use, without opening the page", async () => {
    blocker = createServer();
    await new Promise<void>((done) => blocker!.listen(port, "127.0.0.1", done));
    const outcome = await start();
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome.kind === "failed" && outcome.message).toContain(`Port ${port}`);
    expect(open).not.toHaveBeenCalled();
    // Free again, the next try works.
    await new Promise((done) => blocker!.close(done));
    blocker = null;
    const next = start();
    await opened();
    signIns.abort(STATE);
    await expect(next).resolves.toEqual({ kind: "closed" });
  });

  it("closes the port on abort", async () => {
    const outcome = start();
    await opened();
    signIns.abort(STATE);
    await expect(outcome).resolves.toEqual({ kind: "closed" });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("does not open the page or keep the port for a flow aborted while it came up", async () => {
    const outcome = start();
    signIns.abort(STATE);
    await expect(outcome).resolves.toEqual({ kind: "closed" });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
    expect(open).not.toHaveBeenCalled();
  });

  it("serves several flows on one listener, and closes with the last", async () => {
    const first = start();
    const second = start(OTHER);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await ask(port, `/callback?code=two&state=${OTHER}`);
    await expect(second).resolves.toEqual({ kind: "caught", url: `${redirectUri}?code=two&state=${OTHER}` });
    expect(await held(port)).toBe(true);
    await ask(port, `/callback?code=one&state=${STATE}`);
    await expect(first).resolves.toEqual({ kind: "caught", url: `${redirectUri}?code=one&state=${STATE}` });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("delivers a flow once: its redirect again is an error", async () => {
    const first = start();
    const second = start(OTHER);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await ask(port, `/callback?code=one&state=${STATE}`);
    await first;
    expect((await ask(port, `/callback?code=again&state=${STATE}`)).status).toBe(404);
    signIns.abort(OTHER);
    await second;
  });

  it("ends both on a second start of the same flow, and closes the port", async () => {
    const first = start();
    await opened();
    await expect(start()).resolves.toEqual({ kind: "closed" });
    await expect(first).resolves.toEqual({ kind: "closed" });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("gives up after its time, and closes the port", async () => {
    signIns = new LoopbackSignIns({ port, open, ttlMs: 20 });
    await expect(start()).resolves.toMatchObject({ kind: "failed", message: expect.stringContaining("too long") });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("fails the flow, and closes the port, when the browser won't open", async () => {
    open.mockRejectedValue(new Error(`no handler for ${AUTH}`));
    const outcome = await start();
    expect(outcome).toEqual({ kind: "failed", message: "Couldn’t open your browser. Try again." });
    await vi.waitFor(async () => expect(await held(port)).toBe(false));
  });

  it("can listen again right after closing", async () => {
    const first = start();
    await opened();
    signIns.abort(STATE);
    await first;
    const again = start(OTHER);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await ask(port, `/callback?code=c&state=${OTHER}`);
    await expect(again).resolves.toMatchObject({ kind: "caught" });
  });

  it("never logs the code", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const outcome = start();
    await opened();
    await ask(port, `/callback?code=secret-code&state=wrong-state-1234`);
    await ask(port, `/callback?code=secret-code&state=${STATE}`);
    await outcome;
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
