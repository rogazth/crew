/**
 * A real multi-agent run, measured with the model the prototypes render.
 *
 * Boots `crewd`, creates one agent, and asks it to build a small team and get
 * them talking. Then pulls every transcript back and feeds them through
 * `rosterFrom` / `letters` / `mailbox` / `graph` / `lineage` from
 * `design/shared` — so the agent-network model is validated against data the
 * daemon produced rather than data I wrote.
 *
 *   node tools/crew-test.mjs
 *   node tools/crew-test.mjs --provider claude --model claude-haiku-4-5
 *   node tools/crew-test.mjs --agents 4 --timeout 300000 --keep
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const PROVIDER = arg("provider", "opencode");
const MODEL = arg("model", "opencode/ling-3.0-flash-fin-free");
const TEAM = Number(arg("agents", "3"));
const TIMEOUT = Number(arg("timeout", "240000"));

/** The shared model, bundled on the fly so this script can use it. */
async function loadModel() {
  const out = join(tmpdir(), `crew-model-${process.pid}.mjs`);
  const entry = join(tmpdir(), `crew-model-${process.pid}.ts`);
  writeFileSync(
    entry,
    `export { rosterFrom, letters, mailbox, graph, conversations, lineage, flattenLineage, toolLine } from ${JSON.stringify(
      join(here, "../shared/src/index.ts"),
    )};`,
  );
  await new Promise((ok, fail) => {
    const child = spawn(
      join(repoRoot, "node_modules/.bin/esbuild"),
      [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=error"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    child.stderr.on("data", (c) => (text += c));
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(text))));
  });
  return import(out);
}

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
      }, 90_000);
    });
  }

  close() {
    this.#ws.close();
  }
}

// ---------------------------------------------------------------------------

const model = await loadModel();
const dataDir = mkdtempSync(join(tmpdir(), "crew-team-"));
const sandbox = mkdtempSync(join(tmpdir(), "crew-team-repo-"));
writeFileSync(join(sandbox, "README.md"), "# sandbox\n\nA repository with nothing in it.\n");

const { proc, info } = await boot(dataDir);
const client = await Client.open(info);
console.log(`crewd ${info.url}`);
console.log(`provider ${PROVIDER} / ${MODEL}\n`);

const created = [];
const statuses = [];
client.on("session-created", (payload) => {
  created.push(payload.session);
  console.log(`  + ${payload.session.name}  (${payload.session.provider}/${payload.session.model})`);
});
client.on("session-status", (payload) => statuses.push(`${payload.sessionId.slice(0, 6)}:${payload.status}`));

const workspace = await client.request("workspace_create", { name: "team", path: sandbox });
const lead = await client.request("session_create", {
  workspaceId: workspace.id,
  kind: "agent",
  name: "lead",
  provider: PROVIDER,
  model: MODEL,
  description:
    "You run this workspace. You build teams and delegate. When asked to create agents you use your tools rather than describing what you would create, and you always brief each new agent by messaging it.",
  autonomy: "full",
});

// Scoped hard on purpose. A previous run with an open brief had the team read
// the whole host repository and run its test suite: an agent with `full`
// autonomy is not confined to its workspace's cwd, which is worth knowing.
const PROMPT = `Build me a team of ${TEAM} agents: one for the frontend, one for the backend, one for tests.

For each one:
1. create it,
2. message it with what it owns and who to ask when blocked, and tell it to reply to you with one sentence confirming it understood.

Rules for every agent you create, include them in the description: do not read or write any file, do not run any command, answer only by messaging. This is a wiring test, not real work.

Use your tools. Do not ask me anything.`;

console.log("— running —");
const started = Date.now();
await client.request("turn_start", {
  sessionId: lead.id,
  cwd: sandbox,
  text: PROMPT,
  nonce: crypto.randomUUID(),
});

await new Promise((done) => {
  const timer = setTimeout(done, TIMEOUT);
  let quiet = null;
  client.on("transcript-apply", (payload) => {
    // A turn can complete and then another agent's reply wakes the lead again,
    // so settle on quiet rather than on the first `turn.completed`.
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => {
      clearTimeout(timer);
      done();
    }, 12_000);
  });
});

const elapsed = Math.round((Date.now() - started) / 1000);
console.log(`\nsettled after ${elapsed}s · ${created.length} agent(s) created\n`);

// Pull the whole world back, in the shape the renderer holds it.
const allSessions = await client.request("session_list", { workspaceId: workspace.id });
const threads = {};
for (const session of allSessions) {
  const page = await client.request("transcript_tail", { sessionId: session.id, limit: 400 });
  threads[session.id] = page.blocks;
}

const nameOf = (id) => allSessions.find((s) => s.id === id)?.name ?? id;
const roster = model.rosterFrom(allSessions, threads);

console.log("— sessions —");
for (const session of allSessions) {
  console.log(
    `  ${session.name.padEnd(14)} ${String(threads[session.id].length).padStart(3)} blocks  ` +
      `${session.status.padEnd(12)} ${session.createdBy ? `← ${session.createdBy.name}` : "(root)"}`,
  );
}

console.log("\n— lineage —");
for (const node of model.flattenLineage(model.lineage(allSessions))) {
  console.log(`  ${"  ".repeat(node.depth)}${node.session.name}`);
}

const all = model.letters(roster);
console.log(`\n— letters (${all.length}) —`);
for (const letter of all) {
  console.log(
    `  ${letter.from.name.padEnd(12)} → ${letter.to.name.padEnd(12)} ${letter.state.padEnd(10)} ${letter.text
      .replace(/\s+/g, " ")
      .slice(0, 60)}`,
  );
}

const g = model.graph(roster);
console.log("\n— graph —");
for (const edge of g.edges) {
  console.log(`  ${edge.from.name} → ${edge.to.name}: ${edge.count} (waiting ${edge.waiting})`);
}

console.log("\n— mailboxes —");
for (const session of allSessions) {
  const box = model.mailbox(roster, session.id);
  if (box.length) console.log(`  ${session.name}: ${box.length} waiting`);
}

console.log("\n— every tool row, as a prototype would show it —");
const seen = new Set();
for (const [sessionId, blocks] of Object.entries(threads)) {
  for (const block of blocks) {
    if (block.role !== "tool") continue;
    const line = model.toolLine(block, nameOf);
    const key = `${block.tool?.name}|${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bad = line.text.startsWith("{") || line.text.startsWith("[") || !line.text.trim();
    console.log(
      `  ${bad ? "✕" : "✓"} ${nameOf(sessionId).padEnd(12)} ${(block.tool?.name ?? "").padEnd(26)} ${line.text.slice(0, 64)}${line.suffix ? `  [${line.suffix}]` : ""}`,
    );
  }
}

const unreadable = [...seen].filter((key) => {
  const text = key.split("|")[1] ?? "";
  return text.startsWith("{") || text.startsWith("[") || !text.trim();
}).length;

console.log(
  `\n${unreadable === 0 ? "every tool row reads as a sentence" : `${unreadable} row(s) still unreadable`}`,
);
console.log(`store: ${dataDir}`);

client.close();
if (!process.argv.includes("--keep")) proc.kill("SIGTERM");
process.exit(unreadable === 0 ? 0 : 1);
