// Real crewd on loopback, in temp folders, through the window's real registry:
// what the in-memory tests cannot say is that the links and the daemons agree.
// `cargo build -p crewd` first; without a binary it skips.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { SettingRow } from "../protocol";
import { LOCAL_ENV, Reconciler } from "./reconciler";

const BIN = join(process.cwd(), "target/debug/crewd");
const ROOT = mkdtempSync(join(tmpdir(), "crs-"));
const KEY = "sessions:retention";
const LOCAL_PORT = 18771;
// Apart: a daemon's SOCKS proxy takes the port after its own.
const PORTS: Record<string, number> = { falcon: 18781, devbox: 18791 };

const tokenOf = (name: string) => readFileSync(join(ROOT, name, "token"), "utf8").trim();

vi.mock("../host", async (original) => ({
  ...(await original<typeof import("../host")>()),
  daemonInfo: async () => ({ url: `ws://127.0.0.1:${LOCAL_PORT}`, token: tokenOf("mac") }),
  remotesHost: () => ({
    token: async (id: string) => tokenOf(id),
    endpoint: async (id: string) => `ws://127.0.0.1:${PORTS[id]}`,
  }),
}));

const daemons = new Map<string, ChildProcess>();

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function start(name: string, port: number) {
  const dir = join(ROOT, name);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const child = spawn(BIN, ["serve", "--listen", `127.0.0.1:${port}`, "--data-dir", dir], {
    env: { PATH: process.env.PATH, HOME: home },
    stdio: "ignore",
    // A group of its own: stopping it stops the provider probes it started, which write in its home.
    detached: true,
  });
  daemons.set(name, child);
  if (!(await until(() => portOpen(port)))) throw new Error(`${name} did not start`);
}

function stop(name: string): Promise<void> {
  const child = daemons.get(name);
  daemons.delete(name);
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  });
}

let registry: typeof import("../client/registry");
let reconciler: Reconciler;

const rowOn = async (env: string) => {
  const rows = await registry.request<SettingRow[]>("settings_list", {}, env);
  return rows.find((row) => row.key === KEY);
};

/** A pick in Settings: stored on this machine, then a pass, as `setSetting` does. */
async function choose(value: string | null) {
  await registry.request("settings_set", { key: KEY, value, scope: "global" }, LOCAL_ENV);
  reconciler.kick();
}

const reaches = (env: string, value: string | null, ms = 8_000) =>
  until(async () => {
    const row = await rowOn(env).catch(() => undefined);
    return row !== undefined && row.value === value;
  }, ms);

const addRemote = (id: string) =>
  registry.request("remote_upsert", { id, name: id, host: "127.0.0.1", port: PORTS[id], user: "", ssh: "" });

describe.skipIf(!existsSync(BIN))("settings across real daemons", () => {
  beforeAll(async () => {
    await start("mac", LOCAL_PORT);
    await start("falcon", PORTS.falcon ?? 0);
    registry = await import("../client/registry");
    await addRemote("falcon");
    await registry.refreshRemotes();
    expect(await until(() => registry.linkOf("falcon")?.status === "online")).toBe(true);
    reconciler = new Reconciler({
      keys: () => [KEY],
      request: (method, params, env) => registry.request(method, params, env),
      machines: () =>
        registry
          .getLinks()
          .filter((link) => link.id !== LOCAL_ENV)
          .map((link) => ({ id: link.id, name: link.name, status: link.status, mismatch: link.mismatch })),
    });
    registry.onConnected(() => reconciler.kick());
    reconciler.start();
  }, 60_000);

  afterAll(async () => {
    reconciler?.stop();
    await Promise.all([...daemons.keys()].map(stop));
    // A provider probe a daemon started can still be writing in the home it was given.
    for (let round = 0; round < 6; round += 1) {
      rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one after the other is the point
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, 30_000);

  test("a choice reaches a connected machine", async () => {
    await choose("90");
    expect(await reaches("falcon", "90")).toBe(true);
  });

  test("changing it reaches a connected machine", async () => {
    await choose("30");
    expect(await reaches("falcon", "30")).toBe(true);
  });

  test("going back to Never reaches a connected machine", async () => {
    await choose(null);
    expect(await reaches("falcon", null)).toBe(true);
  });

  test("a choice made while a machine is down reaches it when it is back, with nobody asking", async () => {
    await choose("30");
    expect(await reaches("falcon", "30")).toBe(true);
    await stop("falcon");
    expect(await until(() => registry.linkOf("falcon")?.status !== "online")).toBe(true);
    await choose("7");
    await start("falcon", PORTS.falcon ?? 0);
    expect(await reaches("falcon", "7", 30_000)).toBe(true);
  }, 60_000);

  test("Never chosen while a machine is down reaches it too", async () => {
    await stop("falcon");
    expect(await until(() => registry.linkOf("falcon")?.status !== "online")).toBe(true);
    await choose(null);
    await start("falcon", PORTS.falcon ?? 0);
    expect(await reaches("falcon", null, 30_000)).toBe(true);
  }, 60_000);

  test("a machine that was off when the window opened gets the choice the first time it answers", async () => {
    await choose("90");
    await addRemote("devbox");
    mkdirSync(join(ROOT, "devbox"), { recursive: true });
    await registry.refreshRemotes();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(registry.linkOf("devbox")?.status).not.toBe("online");
    await start("devbox", PORTS.devbox ?? 0);
    expect(await reaches("devbox", "90", 30_000)).toBe(true);
  }, 60_000);
});
