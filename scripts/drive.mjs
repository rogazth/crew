// Drives a real crewd end to end: two agents on real provider CLIs, a message
// between them, and assertions on what came out. This is the demo, headless.
//
//   node scripts/drive.mjs
//   PROVIDER=claude MODEL=claude-opus-5 node scripts/drive.mjs
//
// Defaults to opencode's free models, which need no credentials, so it runs on
// a machine with nothing logged in. Build the daemon first: cargo build -p crewd.
// Node 22+ has a global WebSocket, so there is nothing to install.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const MODEL = process.env.MODEL ?? "opencode/ling-3.0-flash-fin-free";
const PROVIDER = process.env.PROVIDER ?? "opencode";

const dataDir = mkdtempSync(join(tmpdir(), "crew-drive-"));
const workDir = join(dataDir, "work");
mkdirSync(workDir);

const daemon = spawn(join(REPO, "target/debug/crewd"), [`--data-dir=${dataDir}`], {
  stdio: ["pipe", "pipe", "pipe"],
});
daemon.stderr.on("data", (chunk) => process.stderr.write(`[crewd] ${chunk}`));

const info = await new Promise((resolve, reject) => {
  let buffer = "";
  daemon.stdout.on("data", (chunk) => {
    buffer += chunk;
    const line = buffer.split("\n")[0];
    if (buffer.includes("\n")) resolve(JSON.parse(line));
  });
  daemon.on("exit", (code) => reject(new Error(`crewd exited ${code}`)));
});
console.log(`daemon at ${info.url}`);

const ws = new WebSocket(info.url);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.send(JSON.stringify({ auth: info.token }));

let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener("message", (message) => {
  const parsed = JSON.parse(message.data);
  if (parsed.id !== undefined && pending.has(parsed.id)) {
    const { resolve, reject } = pending.get(parsed.id);
    pending.delete(parsed.id);
    parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
    return;
  }
  if (parsed.event) events.push(parsed);
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 120_000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(sessionId, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const snapshot = await rpc("transcript_get", { sessionId });
    if (!snapshot.working && snapshot.status !== "working" && snapshot.status !== "needs-input") {
      // Give a drained letter a moment to start the next turn.
      await sleep(600);
      const again = await rpc("transcript_get", { sessionId });
      if (!again.working) return again;
      continue;
    }
    await sleep(500);
  }
  throw new Error(`${sessionId} never settled`);
}

function show(name, snapshot) {
  console.log(`\n=== ${name} (${snapshot.status}) ===`);
  for (const block of snapshot.blocks) {
    const from = block.fromAgent ? ` from:${block.fromAgent.name}` : "";
    const tool = block.tool ? ` [${block.tool.name} ${block.tool.status}]` : "";
    const detail = block.tool?.detail ? ` detail:${JSON.stringify(block.tool.detail).slice(0, 160)}` : "";
    const text = block.text.replace(/\s+/g, " ").slice(0, 200);
    console.log(`  ${block.role}${from}${tool}: ${text}${detail}`);
  }
}

const workspace = await rpc("workspace_create", { name: "drive", path: workDir });

async function agent(name, description) {
  return rpc("session_create", {
    workspaceId: workspace.id,
    kind: "agent",
    name,
    provider: PROVIDER,
    model: MODEL,
    description,
    autonomy: "full",
  });
}

const coder = await agent("Coder", "You write code and report to Cuddles.");
const cuddles = await agent("Cuddles", "You coordinate. When an agent reports, acknowledge briefly.");
console.log(`coder=${coder.id} cuddles=${cuddles.id}`);

await rpc("turn_start", {
  sessionId: coder.id,
  cwd: workDir,
  text:
    process.env.PROMPT ??
    "Use your message_agent tool to send Cuddles exactly this text: 'the branch is green'. Then reply to me with one short sentence saying you sent it.",
  nonce: crypto.randomUUID(),
});

const coderEnd = await settle(coder.id);
const cuddlesEnd = await settle(cuddles.id);
show("Coder", coderEnd);
show("Cuddles", cuddlesEnd);

const checks = [];
const sent = coderEnd.blocks.find((b) => b.tool?.detail?.kind === "message");
checks.push(["the sender's transcript shows the message it wrote", Boolean(sent), sent ? `to ${sent.tool.detail.to}` : "no message row"]);

const received = cuddlesEnd.blocks.find((b) => b.role === "user" && b.fromAgent);
checks.push(["the reader's transcript shows who wrote to it", Boolean(received), received ? `from ${received.fromAgent.name}: ${received.text.slice(0, 60)}` : "no incoming turn"]);

const answered = cuddlesEnd.blocks.some((b) => b.role === "assistant" && b.text.trim().length > 0);
checks.push(["the reader answered", answered, ""]);

const commands = cuddlesEnd.blocks.filter((b) => b.tool?.detail?.kind === "command");
checks.push(["commands are recorded with their exit code", commands.length === 0 || commands.some((b) => b.tool.detail.exitCode !== undefined), `${commands.length} commands`]);

console.log("\n--- checks ---");
let failed = 0;
for (const [what, ok, note] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${note ? ` (${note})` : ""}`);
}
console.log(`\nevents: ${events.length}`);
ws.close();
daemon.kill("SIGTERM");
await sleep(400);
process.exit(failed === 0 ? 0 : 1);
