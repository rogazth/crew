/**
 * Talks to a real `crewd` the way a prototype would: spawn it, read its
 * `{url, token}` handshake, open the socket, authenticate, and exercise the
 * methods the live `DataSource` depends on.
 *
 * This is the check that says whether "integrate the backend" is a day of work
 * or a week of it.
 *
 *   node tools/daemon-probe.mjs
 *   node tools/daemon-probe.mjs --keep     # leave the daemon running
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function binary() {
  for (const candidate of ["target/release/crewd", "target/debug/crewd"]) {
    const full = join(repoRoot, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error("no crewd binary — run `cargo build -p crewd`");
}

function boot() {
  const exe = binary();
  // A scratch data dir, so probing never touches the real store. stdin must
  // stay open: crewd treats EOF on stdin as "my parent is gone, shut down".
  const home = mkdtempSync(join(tmpdir(), "crew-probe-"));
  const proc = spawn(exe, [`--data-dir=${home}`], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  return new Promise((ok, fail) => {
    const lines = createInterface({ input: proc.stdout });
    const timer = setTimeout(() => fail(new Error(`no handshake in 20s\n${stderr}`)), 20_000);
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return;
        clearTimeout(timer);
        lines.close();
        proc.stdout.resume();
        ok({ proc, info: parsed, home });
      } catch {
        /* log line before the handshake */
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`crewd exited ${code}\n${stderr}`));
    });
  });
}

class Client {
  #ws;
  #next = 1;
  #pending = new Map();
  events = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.event) {
        this.events.push(message.event);
        return;
      }
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      message.ok ? waiter.ok(message.result) : waiter.fail(new Error(message.error));
    });
  }

  static async open(info) {
    const ws = new WebSocket(info.url);
    await new Promise((ok, fail) => {
      ws.addEventListener("open", ok, { once: true });
      ws.addEventListener("error", () => fail(new Error("socket error")), { once: true });
    });
    ws.send(JSON.stringify({ auth: info.token }));
    return new Client(ws);
  }

  request(method, params = {}) {
    const id = this.#next++;
    return new Promise((ok, fail) => {
      this.#pending.set(id, { ok, fail });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, 15_000);
    });
  }

  close() {
    this.#ws.close();
  }
}

const pad = (label) => label.padEnd(26);
let failures = 0;

async function step(label, run) {
  try {
    const result = await run();
    console.log(`  ✓ ${pad(label)} ${result ?? ""}`);
    return result;
  } catch (error) {
    failures += 1;
    console.log(`  ✕ ${pad(label)} ${error.message.split("\n")[0]}`);
    return null;
  }
}

const { proc, info, home } = await boot();
console.log(`crewd up at ${info.url}  (scratch home ${home})`);
const client = await Client.open(info);
console.log("authenticated\n");

console.log("— methods the live DataSource calls —");
const workspaces = await step("workspace_list", async () => {
  const list = await client.request("workspace_list");
  return `${list.length} workspace(s)`;
});

const workspace = await step("workspace_create", async () => {
  const created = await client.request("workspace_create", {
    name: "probe",
    path: repoRoot,
  });
  return created.id;
});

if (workspace) {
  await step("session_list", async () => {
    const list = await client.request("session_list", { workspaceId: workspace });
    return `${list.length} session(s)`;
  });

  const session = await step("session_create", async () => {
    const created = await client.request("session_create", {
      workspaceId: workspace,
      kind: "agent",
      name: "probe-agent",
      provider: "claude",
      model: "claude-opus-5",
      description: "A probe, not a real agent.",
      autonomy: "ask",
    });
    return created.id;
  });

  if (session) {
    await step("transcript_tail", async () => {
      const page = await client.request("transcript_tail", { sessionId: session, limit: 50 });
      return `${page.blocks.length} blocks, seq ${page.seq}, status ${page.status}`;
    });
    await step("session_rename", async () => {
      await client.request("session_rename", { id: session, name: "probe-renamed" });
      return "ok";
    });
    await step("session_set_status", async () => {
      await client.request("session_set_status", { id: session, status: "done" });
      return "ok";
    });
    await step("routine_upsert", async () => {
      const row = await client.request("routine_upsert", {
        id: null,
        sessionId: session,
        name: "probe routine",
        enabled: false,
        prompt: "nothing",
        schedule: JSON.stringify({ kind: "interval", minutes: 60 }),
        nextRunAt: null,
        createdBy: null,
      });
      return row.id;
    });
    await step("routine_list", async () => {
      const list = await client.request("routine_list");
      return `${list.length} routine(s)`;
    });
    await step("messages_search", async () => {
      const hits = await client.request("messages_search", {
        query: "probe",
        sessionIds: [],
        sort: "relevance",
        limit: 20,
      });
      return `${hits.length} hit(s)`;
    });
    await step("session_delete", async () => {
      await client.request("session_delete", { id: session });
      return "ok";
    });
  }

  await step("list_project_files", async () => {
    const files = await client.request("list_project_files", { cwd: repoRoot });
    return `${files.length} file(s)`;
  });
  await step("read_text_file", async () => {
    const text = await client.request("read_text_file", {
      path: join(repoRoot, "package.json"),
    });
    return `${text.length} bytes`;
  });
  await step("state_set / state_get", async () => {
    await client.request("state_set", { key: "probe", value: "1" });
    const back = await client.request("state_get", { key: "probe" });
    return back === "1" ? "round-trips" : `got ${JSON.stringify(back)}`;
  });
  await step("workspace_delete", async () => {
    await client.request("workspace_delete", { id: workspace });
    return "ok";
  });
}

console.log(`\nevents seen: ${[...new Set(client.events)].join(", ") || "none"}`);
console.log(failures === 0 ? "\nall methods answered" : `\n${failures} method(s) failed`);

void workspaces;
client.close();
if (!process.argv.includes("--keep")) proc.kill("SIGTERM");
process.exit(failures === 0 ? 0 : 1);
