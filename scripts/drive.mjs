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

const SCENARIOS = {
  // One agent writes to another and the message shows up on both sides.
  message: {
    prompt:
      "Use your message_agent tool to send Cuddles exactly this text: 'the branch is green'. Then reply to me with one short sentence saying you sent it.",
    check(coderEnd, cuddlesEnd) {
      const sent = coderEnd.blocks.find((b) => b.tool?.detail?.kind === "message");
      const received = cuddlesEnd.blocks.find((b) => b.role === "user" && b.fromAgent);
      return [
        ["the sender's transcript shows the message it wrote", Boolean(sent), sent ? `to ${sent.tool.detail.to}` : "no message row"],
        [
          "the reader's transcript shows who wrote to it",
          Boolean(received),
          received ? `from ${received.fromAgent.name}: ${received.text.slice(0, 60)}` : "no incoming turn",
        ],
        ["the reader answered", cuddlesEnd.blocks.some((b) => b.role === "assistant" && b.text.trim()), ""],
      ];
    },
  },
  // The agent carries itself past the end of a turn by writing to itself.
  loop: {
    prompt:
      "Do this in two turns, not one. Turn one: create a file called step1.txt containing the word one, then call message_agent with to='Coder' (yourself) and text='turn two: create step2.txt containing the word two, then stop'. Say nothing else. You will receive that message as your next turn; carry it out then.",
    check(coderEnd) {
      const turns = coderEnd.blocks.filter((b) => b.role === "user");
      const woken = turns.filter((b) => b.fromAgent);
      const wrote = coderEnd.blocks.filter((b) => b.tool?.detail?.kind === "edit");
      return [
        ["the agent wrote to itself", coderEnd.blocks.some((b) => b.tool?.detail?.kind === "message"), ""],
        ["the note came back as a second turn", woken.length >= 1, `${turns.length} turns, ${woken.length} from an agent`],
        ["both steps ran", wrote.length >= 2, wrote.map((b) => b.tool.detail.path.split("/").pop()).join(", ")],
      ];
    },
  },
  // The agent does real work, and the transcript says what it did.
  code: {
    prompt:
      "Write a file called greet.js in this directory holding a function greet(name) that returns `Hello, ${name}!`, then run `node -e \"console.log(require('./greet.js')('crew'))\"` to prove it works. Reply with the output.",
    check(coderEnd) {
      const tools = coderEnd.blocks.filter((b) => b.tool);
      const wrote = tools.find((b) => b.tool.detail?.kind === "edit");
      const ran = tools.find((b) => b.tool.detail?.kind === "command");
      const greeted = Boolean(ran?.tool.detail.output?.includes("Hello, crew!"));
      return [
        ["the agent called tools at all", tools.length > 0, `${tools.length} rows`],
        ["a file it wrote is named in the transcript", Boolean(wrote), wrote ? wrote.tool.detail.path : "no edit row"],
        // Claude's protocol carries no exit code, so the claim is the command
        // itself; a failure still shows through the row's status.
        [
          "a command it ran is on the row, with its exit code where the provider gives one",
          Boolean(ran?.tool.detail.command),
          ran ? `${ran.tool.detail.command.slice(0, 40)}${ran.tool.detail.exitCode === undefined ? "" : ` (exit ${ran.tool.detail.exitCode})`}` : "no command row",
        ],
        ["the command output is kept", greeted, ran?.tool.detail.output?.trim().slice(0, 60) ?? ""],
        ["every tool row says what it was", tools.every((b) => b.tool.detail || b.tool.title), ""],
      ];
    },
  },
};

const scenario = SCENARIOS[process.env.SCENARIO ?? "message"] ?? SCENARIOS.message;

await rpc("turn_start", {
  sessionId: coder.id,
  cwd: workDir,
  text: process.env.PROMPT ?? scenario.prompt,
  nonce: crypto.randomUUID(),
});

const coderEnd = await settle(coder.id);
const cuddlesEnd = await settle(cuddles.id);
show("Coder", coderEnd);
show("Cuddles", cuddlesEnd);

const checks = scenario.check(coderEnd, cuddlesEnd);

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
