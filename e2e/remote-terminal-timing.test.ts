// How long a terminal on another machine takes to show its first bytes, in the
// ways one opens: ⌘N in a remote workspace (cold and warm), on a slow link,
// after the machine comes back, after a reload, and "Open terminal on
// machine". Every RPC the window sends is traced so a slow open says which
// call it waited on.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright-core";
import type { Session, Workspace } from "../src/lib/types.ts";
import { addRemote, launchCrew, MOD, pressChord, typeInTerminal, waitFor, type Crew, type RemoteDaemon } from "./harness.ts";

type Trace = { t: number; kind: "send" | "recv" | "frame"; url: string; id?: number | undefined; method?: string | undefined; ok?: boolean | undefined; stream?: number };

/** Patches the window's WebSockets to log each request, its answer, and each first PTY frame. */
const installed = new WeakSet<Page>();
async function trace(page: Page): Promise<void> {
  if (!installed.has(page)) {
    installed.add(page);
    await page.addInitScript(tracer);
  }
  await page.evaluate(tracer);
}

function tracer() {
  {
    const w = window as unknown as { __trace?: Trace[]; __traced?: boolean };
    if (w.__traced) return;
    w.__trace = [];
    w.__traced = true;
    const seen = new WeakSet<WebSocket>();
    const methods = new Map<string, string>();
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const log = (w.__trace ??= []);
      if (!seen.has(this)) {
        seen.add(this);
        const url = this.url;
        const frames = new Set<number>();
        this.addEventListener("message", (event) => {
          const t = performance.now();
          if (typeof event.data !== "string") {
            const stream = new DataView(event.data as ArrayBuffer).getUint32(0, true);
            const texts = ((w as unknown as { __text?: Record<string, { t: number; text: string }[]> }).__text ??= {});
            (texts[`${url}#${stream}`] ??= []).push({ t, text: new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer, 4)) });
            if (!frames.has(stream)) {
              frames.add(stream);
              (w.__trace ??= []).push({ t, kind: "frame", url, stream });
            }
            return;
          }
          const message = JSON.parse(event.data) as { id?: number; ok?: boolean; event?: string };
          if (message.id !== undefined) {
            (w.__trace ??= []).push({ t, kind: "recv", url, id: message.id, ok: message.ok, method: methods.get(`${url}#${message.id}`) });
          }
        });
      }
      if (typeof data === "string") {
        const message = JSON.parse(data) as { id?: number; method?: string; params?: { id?: string; cwd?: string; command?: string[] } };
        if (message.method && message.method !== "ping") {
          const pty = message.method === "pty_spawn" || message.method === "pty_kill";
          const detail = pty ? `${message.method}(${message.params?.id?.split("/").pop()}${message.params?.cwd ? ` in ${message.params.cwd}` : ""}${message.params?.command ? ` ${JSON.stringify(message.params.command)}` : ""})` : message.method;
          methods.set(`${this.url}#${message.id}`, detail);
          log.push({ t: performance.now(), kind: "send", url: this.url, id: message.id, method: message.method });
        }
      }
      return send.call(this, data);
    };
  }
}

async function takeTrace(page: Page): Promise<Trace[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __trace?: Trace[] };
    const out = w.__trace ?? [];
    w.__trace = [];
    return out;
  });
}

/** When the text from `dialPort` after `start` first matches `ready`, escapes stripped. */
async function readyAt(crew: Crew, dialPort: number, start: number, ready: RegExp, label: string): Promise<number> {
  let at = Number.POSITIVE_INFINITY;
  await waitFor(
    async () => {
      at = await crew.window.evaluate(
        ({ port, start, source }) => {
          const texts = (window as unknown as { __text?: Record<string, { t: number; text: string }[]> }).__text ?? {};
          const pattern = new RegExp(source);
          for (const [key, chunks] of Object.entries(texts)) {
            if (!key.includes(`:${port}/`)) continue;
            let text = "";
            for (const chunk of chunks) {
              if (chunk.t < start) continue;
              text += chunk.text;
              // eslint-disable-next-line no-control-regex
              if (pattern.test(text.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g, " ").replace(/\s+/g, " "))) return chunk.t;
            }
          }
          return Number.POSITIVE_INFINITY;
        },
        { port: dialPort, start, source: ready.source },
      );
      return Number.isFinite(at);
    },
    { message: `${label}: ready`, timeout: 30_000 },
  ).catch(async (error: unknown) => {
    const dump = await crew.window.evaluate((port) => {
      const texts = (window as unknown as { __text?: Record<string, { t: number; text: string }[]> }).__text ?? {};
      return Object.entries(texts)
        .filter(([key]) => key.includes(`:${port}/`))
        .map(([key, chunks]) => `${key}: ${JSON.stringify(chunks.map((c) => c.text).join("").slice(-300))}`);
    }, dialPort);
    console.log(dump.join("\n"));
    throw error;
  });
  console.log(`[${label}] ready after ${(at - start).toFixed(0)}ms`);
  return at - start;
}

async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/** From `start` to the first PTY frame on `port`'s socket, with a readable call log. */
function report(label: string, start: number, events: Trace[], port: number): number {
  const remote = (event: Trace) => event.url.includes(`:${port}`);
  const byKey = new Map<string, Trace>();
  const lines: string[] = [];
  const first = events.find((event) => event.kind === "frame" && remote(event) && event.t >= start);
  for (const event of events) {
    if (event.t < start) continue;
    if (first && event.t > first.t) break;
    const where = remote(event) ? "remote" : "local ";
    if (event.kind === "send") byKey.set(`${event.url}#${event.id}`, event);
    if (event.kind === "recv") {
      const sent = byKey.get(`${event.url}#${event.id}`);
      lines.push(
        `  ${(event.t - start).toFixed(0).padStart(6)}ms ${where} ${event.method ?? "?"}${event.ok === false ? " (error)" : ""} took ${sent ? (event.t - sent.t).toFixed(0) : "?"}ms`,
      );
    }
    if (event.kind === "frame") lines.push(`  ${(event.t - start).toFixed(0).padStart(6)}ms ${where} first frame on stream ${event.stream}`);
  }
  const total = first ? first.t - start : Number.POSITIVE_INFINITY;
  console.log(`\n[${label}] first remote PTY frame after ${total.toFixed(0)}ms\n${lines.join("\n")}`);
  return total;
}

async function firstFrame(crew: Crew, port: number, start: number, label: string): Promise<number> {
  const events: Trace[] = [];
  await waitFor(
    async () => {
      events.push(...(await takeTrace(crew.window)));
      return events.some((event) => event.kind === "frame" && event.url.includes(`:${port}`) && event.t >= start);
    },
    { message: `${label}: the remote terminal shows its first bytes`, timeout: 30_000 },
  ).catch((error: unknown) => {
    report(label, start, events, port);
    throw error;
  });
  return report(label, start, events, port);
}

/** Opens the machine's repo through ⌘O, as a user does. */
async function openOnMachine(crew: Crew, machine: string, dir: string, name: string): Promise<void> {
  const window = crew.window;
  await pressChord(crew, `${MOD}+o`);
  await window.getByRole("option", { name: new RegExp(machine) }).waitFor();
  await waitFor(
    () => window.getByRole("option", { name: new RegExp(machine) }).evaluate((row) => /\d+ ms/.test(row.textContent ?? "")),
    { message: "the machine answers its heartbeat" },
  );
  await window.keyboard.press(`${MOD}+2`);
  const field = window.getByLabel(`Folder on ${machine}`);
  await field.waitFor();
  await field.fill(`${dir}/`);
  await window.keyboard.press(`${MOD}+Enter`);
  await window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="${name}"]`).waitFor();
}

/** ⌘N (a session running the CLI) or ⌘T ↵ (a plain shell tab), timed to the first byte from `dialPort`. */
async function timedOpen(crew: Crew, dialPort: number, how: "session" | "shell", label: string, ready?: RegExp): Promise<number> {
  await trace(crew.window);
  await takeTrace(crew.window);
  const start = await now(crew.window);
  if (how === "session") {
    await pressChord(crew, `${MOD}+n`);
  } else {
    await pressChord(crew, `${MOD}+t`);
    // Terminal is the launcher's first item, so ↵ on the empty query opens one.
    await crew.window.getByLabel("Open a tab").waitFor();
    await crew.window.keyboard.press("Enter");
  }
  const first = await firstFrame(crew, dialPort, start, label);
  return ready ? readyAt(crew, dialPort, start, ready, label) : first;
}

function newRemoteTerminal(crew: Crew, remote: RemoteDaemon, _workspace: Workspace, label: string): Promise<number> {
  return timedOpen(crew, remote.dialPort, "session", label);
}

function remoteWorkspace(remote: RemoteDaemon, path: string): Promise<Workspace> {
  return rpc<Workspace[]>(remote, "workspace_list").then((list) => {
    const found = list.find((row) => row.path === path);
    assert.ok(found, "the workspace is on the machine");
    return found;
  });
}

function rpc<T>(remote: RemoteDaemon, method: string, params: object = {}, host = "127.0.0.1"): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${remote.port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${method}: no answer`));
    }, 5_000);
    ws.onopen = () => ws.send(JSON.stringify({ auth: remote.token }));
    ws.onerror = () => reject(new Error(`${method}: could not connect`));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { event?: string; id?: number; ok?: boolean; result?: T; error?: string };
      if (message.event === "hello") ws.send(JSON.stringify({ id: 1, method, params }));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.ok) resolve(message.result as T);
      else reject(new Error(message.error ?? method));
    };
  });
}

// Budget for the first bytes of a remote terminal. The fake claude answers at
// once, so anything near this is the app waiting, not the machine.
const FAST_MS = 1_500;

for (const latencyMs of [0, 60]) {
  test(`a terminal on another machine shows its first bytes quickly (${latencyMs}ms each way)`, async () => {
    const crew = await launchCrew();
    let remote: RemoteDaemon | null = null;
    const budget = FAST_MS + latencyMs * 2 * 6;
    try {
      remote = await addRemote(crew, "devbox", { latencyMs });
      const api = await crew.makeRepo("api");
      await openOnMachine(crew, "devbox", api, "api");
      const workspace = await remoteWorkspace(remote, api);

      const cold = await newRemoteTerminal(crew, remote, workspace, `⌘N cold, ${latencyMs}ms`);
      // Still alive once opened: a respawn racing its own kill left a dead pane.
      await typeInTerminal(crew, "!touch alive-cold");
      await waitFor(() => existsSync(path.join(api, "alive-cold")), { message: "the first terminal takes keys" });
      const warm = await newRemoteTerminal(crew, remote, workspace, `⌘N warm, ${latencyMs}ms`);

      // After a reload the open tabs come back and reattach.
      await crew.reload();
      const reloadStart = 0;
      const reload = await firstFrame(crew, remote.dialPort, reloadStart, `reload, ${latencyMs}ms`);

      // The machine goes away and comes back; a new terminal right after.
      await remote.stop();
      await remote.start();
      await waitFor(
        () =>
          crew.window
            .locator('nav[aria-label="Workspaces"] button[data-nav][aria-label="api"] [data-remote-badge]')
            .getAttribute("data-remote-badge")
            .then((state) => state === "online"),
        { message: "the machine is back", timeout: 20_000 },
      );
      const back = await newRemoteTerminal(crew, remote, workspace, `⌘N after reconnect, ${latencyMs}ms`);
      const shell = await timedOpen(crew, remote.dialPort, "shell", `⌘T Terminal, ${latencyMs}ms`);
      await typeInTerminal(crew, "touch alive-shell");
      await waitFor(() => existsSync(path.join(api, "alive-shell")), { message: "the shell takes keys" });

      const sessions = await rpc<Session[]>(remote, "session_list", { workspaceId: workspace.id });
      console.log(`sessions on the machine: ${sessions.map((row) => `${row.kind}/${row.status}`).join(", ")}`);
      for (const [name, ms] of Object.entries({ cold, warm, back, shell })) {
        assert.ok(ms < budget, `${name}: first bytes after ${ms.toFixed(0)}ms, budget ${budget}ms`);
      }
      assert.ok(reload < budget + 3_000, `reload: first bytes after ${reload.toFixed(0)}ms`);
    } finally {
      await remote?.stop();
      await crew.close();
    }
  });
}

test("Open terminal on machine shows a shell's first bytes quickly", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox", { latencyMs: 30 });
    const window = crew.window;
    await pressChord(crew, `${MOD}+,`);
    await window.getByText("Environments", { exact: true }).first().click();
    await window.getByRole("button", { name: "devbox actions" }).click();
    await trace(window);
    await takeTrace(window);
    const start = await now(window);
    await window.getByRole("menuitem", { name: /Open terminal/ }).click();
    const ms = await firstFrame(crew, remote.dialPort, start, "Open terminal on machine, 30ms");
    assert.ok(ms < FAST_MS + 60 * 8, `first bytes after ${ms.toFixed(0)}ms`);
  } finally {
    await remote?.stop();
    await crew.close();
  }
});

// Against a real machine, when one is given:
//   E2E_REMOTE=100.x.y.z:17877 E2E_REMOTE_TOKEN_FILE=/path/token E2E_REMOTE_DIR=/home/me/repo npm run e2e -- remote-terminal-timing
// E2E_REMOTE_DIR must be a folder on that machine; it is opened as a workspace
// and removed from the machine's workspace list at the end.
const real = process.env.E2E_REMOTE;
test("a terminal on a real machine shows its first bytes quickly", { skip: !real && "E2E_REMOTE is not set" }, async () => {
  const [host, port] = real!.split(":");
  const token = (await import("node:fs")).readFileSync(process.env.E2E_REMOTE_TOKEN_FILE!, "utf8").trim();
  const dir = process.env.E2E_REMOTE_DIR!;
  const crew = await launchCrew();
  const dialPort = Number(port);
  const direct = { port: dialPort, token } as RemoteDaemon;
  let created: Workspace | null = null;
  try {
    await crew.window.evaluate((input) => window.crewHost!.remotes!.add(input), {
      id: "",
      name: "real",
      host: host!,
      port: dialPort,
      user: "agent",
      token,
    });
    await crew.reload();
    await openOnMachine(crew, "real", dir, dir.split("/").pop()!);
    created = (await rpcAt(host!, direct, "workspace_list")).find((row) => row.path === dir) ?? null;
    const times: Record<string, number> = {};
    // A bash prompt ends in "$ "; Claude Code draws its input hint, or asks to trust the folder first.
    const shellReady = /\$ $/;
    const claudeReady = /for shortcuts|trust this folder|Do you trust|Try "/;
    times.shell = await timedOpen(crew, dialPort, "shell", "real ⌘T Terminal", shellReady);
    times.session = await timedOpen(crew, dialPort, "session", "real ⌘N", claudeReady);
    times.sessionAgain = await timedOpen(crew, dialPort, "session", "real ⌘N again", claudeReady);
    await crew.reload();
    times.reload = await firstFrame(crew, dialPort, 0, "real reload");
    console.log(JSON.stringify(times));
  } finally {
    if (created) {
      for (const session of await rpcAt<Session[]>(host!, direct, "session_list", { workspaceId: created.id })) {
        await rpcAt(host!, direct, "session_delete", { id: session.id }).catch(() => {});
      }
      await rpcAt(host!, direct, "workspace_delete", { id: created.id }).catch((error: unknown) => console.log(`cleanup: ${error}`));
    }
    await crew.close();
  }
});

function rpcAt<T = Workspace[]>(host: string, remote: RemoteDaemon, method: string, params: object = {}): Promise<T> {
  return rpc<T>({ ...remote, port: remote.port }, method, params, host);
}

// Only the dev renderer runs React's StrictMode, which mounts every new
// terminal twice (spawn, kill, spawn): the first spawn's late answer used to
// write into the pane that replaced it. What each pane is handed is read by
// wrapping the renderer's own Connection, which only the dev server exposes.
test("a new terminal on another machine shows its output once", { skip: !process.env.E2E_DEV_PORT && "needs E2E_DEV_PORT" }, async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox", { latencyMs: 60 });
    const api = await crew.makeRepo("api");
    await openOnMachine(crew, "devbox", api, "api");
    const workspace = await remoteWorkspace(remote, api);
    await crew.window.evaluate(async () => {
      const { Connection } = (await import(/* @vite-ignore */ "/src/lib/client/connection.ts")) as typeof import("../src/lib/client/connection.ts");
      const shown = ((window as unknown as { __shown?: Record<number, number> }).__shown = {});
      const open = Connection.prototype.openStream;
      Connection.prototype.openStream = function (id, onBytes) {
        return open.call(this, id, (bytes) => {
          shown[id] = (shown[id] ?? 0) + bytes.byteLength;
          onBytes(bytes);
        });
      };
    });
    const known = new Set((await rpc<Session[]>(remote, "session_list", { workspaceId: workspace.id })).map((row) => row.id));
    await timedOpen(crew, remote.dialPort, "shell", "⌘T Terminal, dev");
    await pressChord(crew, `${MOD}+n`);
    const session = await waitFor(
      async () => (await rpc<Session[]>(remote!, "session_list", { workspaceId: workspace.id })).find((row) => !known.has(row.id)),
      { message: "the session is created" },
    );
    // Let both settle: every late answer and replay has landed.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const shown = await crew.window.evaluate(() => (window as unknown as { __shown: Record<number, number> }).__shown);
    for (const pane of [`${workspace.id}/stub:terminal`, `${workspace.id}/session:${session.id}`]) {
      const attached = await rpc<{ start: number; emitted: number }>(remote, "pty_attach", { id: pane, from: Number.MAX_SAFE_INTEGER });
      const streams = Object.entries(shown).filter(([, bytes]) => bytes > 0);
      console.log(`${pane.split("/").pop()}: printed ${attached.emitted} bytes; panes were handed ${JSON.stringify(shown)}`);
      assert.ok(streams.length <= 2, `one stream per pane, got ${streams.length}`);
    }
    const total = Object.values(shown).reduce((sum, bytes) => sum + bytes, 0);
    const printed = await Promise.all(
      [`${workspace.id}/stub:terminal`, `${workspace.id}/session:${session.id}`].map((pane) =>
        rpc<{ emitted: number }>(remote!, "pty_attach", { id: pane, from: Number.MAX_SAFE_INTEGER }).then((row) => row.emitted),
      ),
    );
    assert.equal(total, printed[0]! + printed[1]!, "each byte a terminal printed is shown once");
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
