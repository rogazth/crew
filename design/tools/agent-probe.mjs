/**
 * Drives a real turn against a real provider and records exactly what the
 * transcript receives — so the prototypes are designed against what the daemon
 * actually sends, not against what the fixtures imagine.
 *
 * It asks an agent to do the two things the design work is about: create another
 * agent, and write to it. Then it prints every block the daemon produced, with
 * the raw `title` next to the line each design would show.
 *
 *   node tools/agent-probe.mjs                       # opencode, free model
 *   node tools/agent-probe.mjs --provider claude --model claude-haiku-4-5
 *   node tools/agent-probe.mjs --keep                # leave the store behind
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const PROVIDER = arg("provider", "opencode");
const MODEL = arg("model", "opencode/ling-3.0-flash-fin-free");
const TIMEOUT_MS = Number(arg("timeout", "180000"));

function binary() {
  for (const candidate of ["target/release/crewd", "target/debug/crewd"]) {
    const full = join(repoRoot, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error("no crewd binary — run `cargo build -p crewd`");
}

function boot(dataDir) {
  const proc = spawn(binary(), [`--data-dir=${dataDir}`], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  return new Promise((ok, fail) => {
    const lines = createInterface({ input: proc.stdout });
    const timer = setTimeout(() => fail(new Error(`no handshake\n${stderr}`)), 20_000);
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        if (!parsed.url) return;
        clearTimeout(timer);
        lines.close();
        proc.stdout.resume();
        ok({ proc, info: parsed });
      } catch {
        /* not the handshake */
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
  handlers = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.event) {
        for (const handler of this.handlers.get(message.event) ?? []) handler(message.payload);
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

  on(event, handler) {
    const set = this.handlers.get(event) ?? [];
    set.push(handler);
    this.handlers.set(event, set);
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
      }, 60_000);
    });
  }

  close() {
    this.#ws.close();
  }
}

// ---------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), "crew-agent-probe-"));
// A scratch repo, so the agent has somewhere harmless to be.
const sandbox = mkdtempSync(join(tmpdir(), "crew-sandbox-"));
writeFileSync(join(sandbox, "README.md"), "# sandbox\n\nNothing here.\n");

const { proc, info } = await boot(dataDir);
console.log(`crewd ${info.url}`);
console.log(`provider ${PROVIDER} / ${MODEL}`);
console.log(`sandbox ${sandbox}\n`);

const client = await Client.open(info);

const events = [];
const applied = [];
const created = [];
const statuses = [];

client.on("transcript-apply", (payload) => {
  events.push(payload.event.type);
  applied.push(payload);
});
client.on("session-created", (payload) => {
  created.push(payload.session);
  console.log(`  ⟶ session-created: ${payload.session.name} (${payload.session.provider}/${payload.session.model})`);
});
client.on("session-status", (payload) => statuses.push(payload.status));

const workspace = await client.request("workspace_create", { name: "probe", path: sandbox });
const agent = await client.request("session_create", {
  workspaceId: workspace.id,
  kind: "agent",
  name: "lead",
  provider: PROVIDER,
  model: MODEL,
  description:
    "You are the lead of this workspace. When asked to build a team, you use your tools to create agents rather than describing what you would create.",
  autonomy: "full",
});
console.log(`agent ${agent.name} ${agent.id}\n`);

const PROMPT = `Create one agent called "reviewer" whose job is reviewing pull requests, then send it a short message telling it what to start with. Use your tools. Do not ask me anything; do it now and then tell me in one sentence what you did.`;

console.log("— turn —");
const started = Date.now();
await client.request("turn_start", {
  sessionId: agent.id,
  cwd: sandbox,
  text: PROMPT,
  nonce: crypto.randomUUID(),
});

await new Promise((done) => {
  const timer = setTimeout(done, TIMEOUT_MS);
  client.on("transcript-apply", (payload) => {
    if (payload.event.type === "turn.completed" || payload.event.type === "session.ended") {
      clearTimeout(timer);
      setTimeout(done, 1_500);
    }
  });
});

const elapsed = Math.round((Date.now() - started) / 1000);
console.log(`\nturn finished in ${elapsed}s`);
console.log(`events: ${[...new Set(events)].join(", ")}`);
console.log(`statuses: ${[...new Set(statuses)].join(" → ") || "none"}`);
console.log(`agents created: ${created.length}`);

const page = await client.request("transcript_tail", { sessionId: agent.id, limit: 200 });
console.log(`\n— transcript (${page.blocks.length} blocks) —`);
for (const block of page.blocks) {
  const head = `  ${block.role.padEnd(10)}`;
  if (block.role === "tool") {
    const detail = block.tool?.detail;
    const raw = (block.tool?.title ?? "").replace(/\s+/g, " ").slice(0, 58);
    console.log(
      `${head} name=${(block.tool?.name ?? "").padEnd(28)} detail=${detail ? detail.kind : "NONE"}`,
    );
    console.log(`${" ".repeat(12)} raw title: ${JSON.stringify(raw)}`);
    if (process.argv.includes("--raw")) {
      console.log(`${" ".repeat(12)} detail: ${JSON.stringify(detail).slice(0, 900)}`);
    }
  } else {
    console.log(`${head} ${block.text.replace(/\s+/g, " ").slice(0, 96)}`);
  }
}

// What the receiving agent's box looks like from the other side.
for (const child of created) {
  const childPage = await client.request("transcript_tail", { sessionId: child.id, limit: 50 });
  console.log(`\n— ${child.name} transcript (${childPage.blocks.length} blocks) —`);
  for (const block of childPage.blocks) {
    console.log(
      `  ${block.role.padEnd(10)} ${block.fromAgent ? `[from ${block.fromAgent.name}] ` : ""}${block.text.replace(/\s+/g, " ").slice(0, 88)}`,
    );
  }
}

console.log(`\nstore: ${dataDir}`);
client.close();
if (!process.argv.includes("--keep")) proc.kill("SIGTERM");
process.exit(0);
