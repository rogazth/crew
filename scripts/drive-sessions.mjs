// Drives the session lifecycle end to end against a real crewd and the real
// provider CLIs: a parent starts sessions, waits on them, reads them, gives
// them more, answers them, stops them; the daemon restarts under them.
//
//   cargo build -p crewd -p crew-cli && node scripts/drive-sessions.mjs
//   PROVIDERS=codex,claude SCENARIOS=a,e node scripts/drive-sessions.mjs
//
// Each scenario runs once per provider it applies to and the run ends with a
// scenario × provider table: pass, FAIL, or n/a with the reason. A provider
// whose CLI is not installed is reported as such, never skipped quietly.
//
// The parent is a terminal session of this daemon: a shell in one of its PTYs
// hands this script its token, so every call goes over the bridge exactly as
// that terminal's CLI would make it. Scenario a puts a real Claude Code in that
// terminal instead; b puts a real Claude agent in charge.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CREWD = join(REPO, "target/debug/crewd");
const MODELS = {
  claude: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
  codex: process.env.CODEX_MODEL ?? "gpt-5.6-terra",
  opencode: process.env.OPENCODE_MODEL ?? "opencode/nemotron-3.5-lightning-free",
  cursor: process.env.CURSOR_MODEL ?? "auto",
};
const BINARIES = { claude: "claude", codex: "codex", opencode: "opencode", cursor: "cursor-agent" };
const ALL = ["claude", "codex", "opencode", "cursor"];
const PROVIDERS = (process.env.PROVIDERS ?? ALL.join(",")).split(",").filter(Boolean);
const SCENARIOS = (process.env.SCENARIOS ?? "a,b,c,d,e,f,g,h,i,j,k").split(",").filter(Boolean);
const KEEP = process.env.KEEP === "1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function installed(provider) {
  try {
    execFileSync("sh", ["-c", `command -v ${BINARIES[provider]}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- the daemon -------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), "crew-sl-"));
const repo = join(dataDir, "repo");
mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "drive@crew.test");
git("config", "user.name", "Drive");
writeFileSync(join(repo, "README.md"), "# drive\n");
writeFileSync(join(repo, "notes.txt"), "the secret word is PELICAN\n");
git("add", ".");
git("commit", "-q", "-m", "init");

let daemon;
let info;
let ws;
let nextId = 1;
const pending = new Map();
const events = [];

async function startDaemon(env = {}) {
  daemon = spawn(CREWD, [`--data-dir=${dataDir}`], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CREW_SOCKET: "", CREW_TOKEN: "", ...env },
  });
  daemon.stderr.on("data", (chunk) => {
    if (process.env.VERBOSE) process.stderr.write(`[crewd] ${chunk}`);
  });
  info = await new Promise((resolve, reject) => {
    let buffer = "";
    daemon.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
    });
    daemon.on("exit", (code) => reject(new Error(`crewd exited ${code}`)));
  });
  ws = new WebSocket(info.url);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(JSON.stringify({ auth: info.token }));
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
}

async function stopDaemon() {
  ws?.close();
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  daemon.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
}

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

/** A tool call over the bridge, as whoever `token` is. Resolves to the parsed answer. */
function bridge(token, method, params = {}, timeoutMs = 90_000) {
  const socket = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")).socket;
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`${method} ${params.name ?? ""} timed out`));
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify({ token, method, params }) + "\n"));
    conn.on("data", (chunk) => (buffer += chunk));
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(new Error(`bad reply ${buffer}: ${error}`));
      }
    });
  });
}

/** Runs a tool as `token`; resolves to { ok, value, text }. */
async function tool(token, name, args = {}) {
  const timeout = typeof args.timeout_s === "number" ? (args.timeout_s + 15) * 1000 : 90_000;
  const reply = await bridge(token, "tools/call", { name, arguments: args }, timeout);
  if (reply.error) return { ok: false, text: reply.error };
  const text = reply.result.content.map((block) => block.text ?? "").join("\n");
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    // a refusal or a plain string
  }
  return { ok: !reply.result.isError, value, text };
}

async function must(token, name, args) {
  const out = await tool(token, name, args);
  if (!out.ok) throw new Error(`${name} refused: ${out.text}`);
  return out.value;
}

function userToken() {
  return JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")).userToken;
}

// --- a workspace and a terminal that hands over its token -------------------

let workspace;

/** A terminal session whose shell writes its token to a file and sleeps. */
async function terminal(name) {
  const row = await rpc("session_create", {
    workspaceId: workspace.id,
    kind: "terminal",
    name,
    provider: "claude",
    model: "",
    description: "",
    autonomy: "full",
  });
  const file = join(dataDir, `token-${row.id}`);
  await rpc("pty_spawn", {
    id: row.id,
    cwd: repo,
    command: ["/bin/sh", "-c", `printf %s "$CREW_TOKEN" > '${file}'; exec sleep 100000`],
    cols: 80,
    rows: 24,
    session: row.id,
  });
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(50);
  await sleep(100);
  return { ...row, token: readFileSync(file, "utf8").trim() };
}

async function setAutonomy(row, autonomy) {
  await rpc("session_update", {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    description: row.description ?? "",
    notifications: true,
    autonomy,
  });
}

/** Waits on one session until an event comes, up to `seconds` in 60 s calls. */
async function waitEvent(token, id, seconds = 300, since) {
  const until = Date.now() + seconds * 1000;
  let cursors = since === undefined ? undefined : { [id]: since };
  while (Date.now() < until) {
    const out = await must(token, "wait_for_session", { sessions: [id], timeout_s: 60, ...(cursors ? { cursors } : {}) });
    if (out.result === "event") return out;
    if (out.result === "nothing-running") return out;
    cursors = out.cursors;
  }
  throw new Error(`no event from ${id} in ${seconds}s`);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

export {
  REPO, MODELS, ALL, PROVIDERS, SCENARIOS, sleep, log, installed, dataDir, repo, git,
  startDaemon, stopDaemon, rpc, bridge, tool, must, userToken, terminal, setAutonomy, waitEvent, assert,
};

// --- the run ----------------------------------------------------------------

const smoke = process.env.SMOKE === "1";
if (smoke) {
  await startDaemon();
  workspace = await rpc("workspace_create", { name: "drive", path: repo });
  const shell = await terminal("parent");
  const provider = PROVIDERS[0];
  log(`smoke: ${provider}`);
  const started = await must(shell.token, "start_session", {
    provider,
    model: MODELS[provider],
    prompt: "Read notes.txt and tell me the secret word. Do not change any file.",
  });
  log("started", started);
  const waited = await waitEvent(shell.token, started.id);
  log("waited", JSON.stringify(waited, null, 1));
  const read = await must(shell.token, "read_session", { session: started.id });
  log("read", read.text);
  const sent = await must(shell.token, "send_to_session", { session: started.id, text: "What was the word you found? Answer with the word only." });
  log("sent", sent);
  const second = await waitEvent(shell.token, started.id);
  log("second", JSON.stringify(second, null, 1));
  await stopDaemon();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
