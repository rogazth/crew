// Drives a real crewd end to end: two bots on real provider CLIs, a message
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
    const snapshot = await rpc("transcript_tail", { sessionId, limit: 500 });
    if (!snapshot.working && snapshot.status !== "working" && snapshot.status !== "needs-input") {
      // Give a drained letter a moment to start the next turn.
      await sleep(600);
      const again = await rpc("transcript_tail", { sessionId, limit: 500 });
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
    const from = block.fromBot ? ` from:${block.fromBot.name}` : "";
    const tool = block.tool ? ` [${block.tool.name} ${block.tool.status}]` : "";
    const detail = block.tool?.detail ? ` detail:${JSON.stringify(block.tool.detail).slice(0, 160)}` : "";
    const text = block.text.replace(/\s+/g, " ").slice(0, 200);
    console.log(`  ${block.role}${from}${tool}: ${text}${detail}`);
  }
}

const workspace = await rpc("workspace_create", { name: "drive", path: workDir });

async function bot(name, description) {
  return rpc("session_create", {
    workspaceId: workspace.id,
    kind: "bot",
    name,
    provider: PROVIDER,
    model: MODEL,
    description,
    autonomy: "full",
  });
}

const coder = await bot("Coder", "You write code and report to Cuddles.");
const cuddles = await bot("Cuddles", "You coordinate. When a bot reports, acknowledge briefly.");
console.log(`coder=${coder.id} cuddles=${cuddles.id}`);

const SCENARIOS = {
  // One bot writes to another and the message shows up on both sides.
  message: {
    // Named, not addressed: bots are reached by id, so the way through is
    // list_peers first. A prompt that handed over the id would skip the half
    // of this that goes wrong in practice.
    prompt:
      "Send the bot called Cuddles exactly this text: 'the branch is green'. Then reply to me with one short sentence saying you sent it.",
    check(coderEnd, cuddlesEnd) {
      const sent = coderEnd.blocks.find((b) => b.tool?.detail?.kind === "message");
      const received = cuddlesEnd.blocks.find((b) => b.role === "user" && b.fromBot);
      return [
        ["the sender's transcript shows the message it wrote", Boolean(sent), sent ? `to ${sent.tool.detail.to}` : "no message row"],
        [
          "the reader's transcript shows who wrote to it",
          Boolean(received),
          received ? `from ${received.fromBot.name}: ${received.text.slice(0, 60)}` : "no incoming turn",
        ],
        ["the reader answered", cuddlesEnd.blocks.some((b) => b.role === "assistant" && b.text.trim()), ""],
      ];
    },
  },
  // The bot hands a job to a session and ends its turn; the session's report
  // wakes it, as a turn opening "## Report from session".
  delegate: {
    prompt:
      "Use Crew's start_session to hand this job to a new session: 'What is 17 times 23? Reply with the number only.' Do not wait for it: end your turn right after starting it. When its report arrives, reply with RESULT: <the number it reported>.",
    until: (end) => end.blocks.some((b) => b.role === "assistant" && /RESULT:\s*\**391/.test(b.text)),
    async check(coderEnd) {
      const child = (await rpc("session_list", { workspaceId: workspace.id })).find((s) => s.kind === "child" && s.parentId === coder.id);
      const woken = coderEnd.blocks.find((b) => b.role === "user" && b.fromBot?.id === child?.id);
      return [
        ["the bot started a session of its own", Boolean(child), child ? `${child.provider}/${child.model}` : "no child"],
        ["its report woke the bot as a turn", Boolean(woken), woken ? woken.text.slice(0, 60) : "no report turn"],
        ["the bot passed the result on", coderEnd.blocks.some((b) => b.role === "assistant" && /RESULT:\s*\**391/.test(b.text)), ""],
      ];
    },
  },
  // The bot needs the answer in the same turn: start_session with wait hands
  // the report back, and the same report does not wake it again.
  wait: {
    prompt:
      "Use Crew's start_session with wait set to true to hand this job to a new session: 'What is 17 times 23? Reply with the number only.' Then reply with RESULT: <the number it reported>.",
    async check(coderEnd) {
      const child = (await rpc("session_list", { workspaceId: workspace.id })).find((s) => s.kind === "child" && s.parentId === coder.id);
      const turns = coderEnd.blocks.filter((b) => b.role === "user");
      const start = coderEnd.blocks.find((b) => b.tool?.name?.includes("start_session"));
      return [
        ["the bot started a session of its own", Boolean(child), child ? `${child.provider}/${child.model}` : "no child"],
        ["it waited for the report in its own turn", /"reported"/.test(JSON.stringify(start?.tool ?? {})) || coderEnd.blocks.some((b) => b.role === "assistant" && /391/.test(b.text)), ""],
        ["the report did not wake it again", turns.length === 1 && !turns.some((b) => b.fromBot), `${turns.length} turns`],
        ["the bot passed the result on", coderEnd.blocks.some((b) => b.role === "assistant" && /RESULT:\s*\**391/.test(b.text)), ""],
      ];
    },
  },
  // Naming a model the way a person does, under a provider that does not have
  // it. A codex bot asked for "grok 4.6" and reported back that Grok was not
  // available here; it is, under cursor, spelled cursor-grok-4.6-high.
  create: {
    prompt:
      "Create a bot called Scout that runs on Grok 4.6 and reads documentation. Then reply with one short sentence saying what provider and model it ended up on.",
    async check(coderEnd) {
      const made = (await rpc("session_list", { workspaceId: workspace.id })).find(
        (s) => s.name === "Scout",
      );
      // Straight at it, in one round.
      const asked = coderEnd.blocks.filter((b) => b.tool?.name?.includes("create_bot"));
      return [
        ["the bot was created at all", Boolean(made), made ? `${made.provider}/${made.model}` : "no Scout"],
        [
          "it landed on the provider that has Grok",
          made?.provider === "cursor" && made?.model?.includes("grok-4.6"),
          made ? `${made.provider}/${made.model}` : "",
        ],
        ["it got there in one call", asked.length === 1, `${asked.length} calls`],
      ];
    },
  },
  // A standing order comes due and the daemon wakes the bot for it, with no
  // window open anywhere.
  routine: {
    async start() {
      await rpc("routine_upsert", {
        sessionId: coder.id,
        name: "Morning check",
        enabled: true,
        prompt: "Reply with exactly: the branch is green",
        schedule: JSON.stringify({ kind: "interval", minutes: 60 }),
        // Due a moment ago, so the daemon's first tick picks it up.
        nextRunAt: Date.now() - 1000,
      });
      // The scheduler wakes on its own; nothing here asks it to.
      await sleep(3000);
    },
    check(coderEnd) {
      const note = coderEnd.blocks.find(
        (b) => b.role === "system" && b.text.startsWith("Routine ·"),
      );
      const woken = coderEnd.blocks.find((b) => b.role === "user" && b.hidden);
      const answered = coderEnd.blocks.some((b) => b.role === "assistant" && b.text.trim());
      return [
        ["the daemon fired it with no client asking", Boolean(note), note?.text ?? "no routine note"],
        [
          "the bot was woken with the standing order",
          Boolean(woken?.text.includes("the branch is green")),
          woken ? woken.text.slice(0, 60) : "no hidden turn",
        ],
        ["it carried the order out", answered, ""],
      ];
    },
  },
  // The bot does real work, and the transcript says what it did.
  code: {
    prompt:
      "Write a file called greet.js in this directory holding a function greet(name) that returns `Hello, ${name}!`, then run `node -e \"console.log(require('./greet.js')('crew'))\"` to prove it works. Reply with the output.",
    check(coderEnd) {
      const tools = coderEnd.blocks.filter((b) => b.tool);
      const wrote = tools.find((b) => b.tool.detail?.kind === "edit");
      const ran = tools.find((b) => b.tool.detail?.kind === "command");
      const greeted = Boolean(ran?.tool.detail.output?.includes("Hello, crew!"));
      return [
        ["the bot called tools at all", tools.length > 0, `${tools.length} rows`],
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

if (scenario.start) {
  await scenario.start();
} else {
  await rpc("turn_start", {
    sessionId: coder.id,
    cwd: workDir,
    text: process.env.PROMPT ?? scenario.prompt,
    nonce: crypto.randomUUID(),
  });
}

if (scenario.until) {
  const until = Date.now() + 600_000;
  while (Date.now() < until && !scenario.until(await rpc("transcript_tail", { sessionId: coder.id, limit: 500 }))) await sleep(2000);
}
const coderEnd = await settle(coder.id);
const cuddlesEnd = await settle(cuddles.id);
show("Coder", coderEnd);
show("Cuddles", cuddlesEnd);

const checks = await scenario.check(coderEnd, cuddlesEnd);

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
