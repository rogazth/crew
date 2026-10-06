// Drives the session lifecycle end to end against a real crewd and the real
// provider CLIs: a parent starts sessions, waits on them, reads them, gives
// them more (send_message), answers their questions, stops them; the daemon
// restarts under them.
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
// terminal instead; b puts a real Claude bot in charge.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const CREWD = join(REPO, "target/debug/crewd");
const MODELS = {
  claude: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5",
  codex: process.env.CODEX_MODEL ?? "gpt-5.6-terra",
  opencode: process.env.OPENCODE_MODEL ?? "opencode/nemotron-3.5-lightning-free",
  cursor: process.env.CURSOR_MODEL ?? "auto",
};
// Who runs the bots of scenarios v and x.
const BOT = process.env.BOT_PROVIDER ?? "claude";
const BINARIES = { claude: "claude", codex: "codex", opencode: "opencode", cursor: "cursor-agent" };
const ALL = ["claude", "codex", "opencode", "cursor"];
const PROVIDERS = (process.env.PROVIDERS ?? ALL.join(",")).split(",").filter(Boolean);
const SCENARIOS = (process.env.SCENARIOS ?? "a,b,w,c,d,e,f,q,p,g,h,i,j,k,m,s").split(",").filter(Boolean);
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
// Named apart from every other run: Crew keeps the worktrees it makes under
// ~/.crew/worktrees/<repo name>, and this run removes its own when it ends.
const repoName = `drive-sessions-${Math.random().toString(36).slice(2, 8)}`;
const repo = join(dataDir, repoName);
const worktreesHome = join(homedir(), ".crew", "worktrees", repoName);
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
    // The user's token names its workspace on every call; a session's is ignored.
    conn.on("connect", () => conn.write(JSON.stringify({ token, method, params, workspace: workspace?.id }) + "\n"));
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

/** What the parent last saw of each session, as its cursor. */
const lastSeen = new Map();

/**
 * Until the session has an event past `since` (or past what was last seen of
 * it) and is not working: a turn ended, it stopped to ask, it failed or it
 * exited. Read from the window's side (`session_get`, `transcript_tail`), so it
 * marks nothing seen: there is no wait tool any more, a bot is woken and a
 * terminal reads.
 */
async function waitEvent(_token, id, seconds = 300, since) {
  const from = since ?? lastSeen.get(id) ?? 0;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const now = await row(id);
    if (now.cursor > from && !["starting", "working"].includes(now.status)) {
      lastSeen.set(id, now.cursor);
      return { result: "event", sessions: [await describe(now)], cursors: { [id]: now.cursor } };
    }
    await sleep(500);
  }
  throw new Error(`no event from ${id} in ${seconds}s`);
}

/** A session's latest event, as the old wait answered it. */
async function describe(now) {
  const tail = await rpc("transcript_tail", { sessionId: now.id, limit: 300 });
  const blocks = tail.blocks;
  let report = "";
  for (let at = blocks.length - 1; at >= 0; at--) {
    if (blocks[at].role === "user") break;
    if (blocks[at].role === "assistant" && blocks[at].text.trim()) {
      report = blocks[at].text.trim();
      break;
    }
  }
  const approval = [...blocks].reverse().find((block) => block.approval && !block.approval.decided);
  const question = [...blocks].reverse().find((block) => block.question && !block.question.answers && !block.question.dismissed);
  const event = { idle: "turn", done: "turn", error: "error", exited: "exited", "needs-input": "needs-input" }[now.status] ?? now.status;
  const last = blocks[blocks.length - 1];
  return {
    id: now.id,
    status: now.status,
    event,
    report,
    outcome: event === "error" || event === "exited" ? (last?.text ?? "") : "",
    request:
      event !== "needs-input"
        ? undefined
        : approval
          ? { kind: "approval", request_id: approval.approval.requestId }
          : question
            ? { kind: "question", request_id: question.question.requestId, questions: question.question.questions }
            : undefined,
  };
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}


// --- what the scenarios share ----------------------------------------------

const word = (base) => `${base}${Math.floor(1000 + Math.random() * 9000)}`;

async function start(token, provider, prompt, extra = {}) {
  const out = await must(token, "start_session", { provider, model: MODELS[provider], prompt, ...extra });
  return out.id;
}

/** Waits until every named session has had a turn end, collecting the events in the order they ended. */
async function waitAll(token, ids, seconds = 600) {
  const until = Date.now() + seconds * 1000;
  const seen = [];
  const left = new Set(ids);
  while (left.size && Date.now() < until) {
    for (const id of [...left]) {
      const now = await row(id);
      if (now.cursor > (lastSeen.get(id) ?? 0) && !["starting", "working"].includes(now.status)) {
        lastSeen.set(id, now.cursor);
        seen.push(await describe(now));
        left.delete(id);
      }
    }
    await sleep(500);
  }
  return seen;
}

async function row(id) {
  return rpc("session_get", { id });
}

async function untilStatus(id, wanted, seconds = 300) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const now = await row(id);
    if (wanted.includes(now.status)) return now;
    await sleep(500);
  }
  throw new Error(`${id} never got to ${wanted.join("/")} (it is ${(await row(id)).status})`);
}

/**
 * Until the session's CLI has been running its turn for `settle` seconds: mid-turn.
 * Not "until a tool shows": opencode reports a tool only once it has finished.
 */
async function untilTool(token, id, settle = 12, seconds = 180) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const now = await row(id);
    if (now.status === "working" && cliIn(await cwdOf(now))) {
      await sleep(settle * 1000);
      const later = await row(id);
      assert(later.status === "working", `${id} ended its turn before it could be caught mid-turn: ${later.status}`);
      return later;
    }
    await sleep(500);
  }
  throw new Error(`${id} never got going`);
}

/** The folder a session's CLI runs in, as /proc shows it. */
async function cwdOf(session) {
  return execFileSync("realpath", [session.worktree ?? repo]).toString().trim();
}

/** The process group of the CLI crewd runs for a session working in `cwd`. */
function cliIn(cwd) {
  const crewd = daemon.pid;
  if (!existsSync("/proc")) {
    // macOS: crewd's children, and the folder each one runs in, from lsof.
    let pids = [];
    try {
      pids = execFileSync("pgrep", ["-P", String(crewd)]).toString().split("\n").filter(Boolean);
    } catch {
      return null;
    }
    for (const pid of pids) {
      try {
        const where = execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]).toString().split("\n").find((line) => line.startsWith("n"));
        if (where?.slice(1) === cwd) return Number(pid);
      } catch {
        // gone
      }
    }
    return null;
  }
  for (const pid of execFileSync("ls", ["/proc"]).toString().split("\n").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid !== crewd) continue;
      const where = execFileSync("readlink", [`/proc/${pid}/cwd`]).toString().trim();
      if (where === cwd) return Number(pid);
    } catch {
      // gone, or not ours to read
    }
  }
  return null;
}

// --- the scenarios ----------------------------------------------------------
// Each takes a provider and throws on a failure; "n/a: why" is returned for one
// that cannot apply to it.

/**
 * A job whose one command its CLI asks before running under ask autonomy:
 * Claude asks for any shell command; Codex's sandbox lets a write in the
 * workspace through, so the command writes outside it.
 */
function askJob(provider, file) {
  const path = provider === "codex" ? join(homedir(), `.crew-drive-${file}`) : null;
  const command = path ? `touch ${path}` : `touch ${file}`;
  return {
    prompt: `Run the shell command \`${command}\`, then reply with the word DONE.`,
    done: (child) => {
      const where = path ?? join(child.worktree ?? repo, file);
      const there = existsSync(where);
      if (path) rmSync(path, { force: true });
      return there;
    },
  };
}

const scenarios = {
  // The motivating case: a real Claude Code in a terminal hands a job to a
  // session in a new worktree and waits for its report in the same call.
  async a(provider) {
    const shell = await rpc("session_create", {
      workspaceId: workspace.id, kind: "terminal", name: `claude-a-${provider}`, provider: "claude", model: "", description: "", autonomy: "full",
    });
    const secret = word("OTTER");
    const out = join(dataDir, `a-${provider}.txt`);
    const job = `Create a file named greeting.txt containing exactly the word ${secret}, and commit it to git with the message 'add greeting'. Report the commit hash.`;
    const prompt = [
      "You are testing Crew's session tools. They are in the crew MCP server, in your tool list as mcp__crew__<name> (mcp__crew__start_session, mcp__crew__read_session). If you do not see them, call one by name once before deciding they are unavailable. Do exactly this, nothing else:",
      `1. start_session with provider "${provider}", model "${MODELS[provider]}", worktree "new", name "a-${provider}", wait true, and prompt: ${JSON.stringify(job)}`,
      "2. If its status is not \"reported\", call read_session on its id every 30 seconds until the transcript shows the turn ended.",
      `3. Write the report it gave (the report field of start_session's answer, or its last message) into the file ${out}, then stop.`,
    ].join("\n");
    await rpc("pty_spawn", {
      id: shell.id, cwd: repo, cols: 120, rows: 40, session: shell.id,
      command: ["claude", "-p", prompt, "--model", MODELS.claude, "--dangerously-skip-permissions"],
    });
    const until = Date.now() + 15 * 60_000;
    while (!existsSync(out) && Date.now() < until) await sleep(2000);
    assert(existsSync(out), "Claude Code never wrote the report down");
    const sessions = await rpc("session_list", { workspaceId: workspace.id });
    const child = sessions.find((s) => s.kind === "child" && s.parentId === shell.id);
    assert(child, "no child session with the terminal as its parent");
    assert(child.provider === provider, `the child runs ${child.provider}`);
    assert(child.worktree && child.worktree !== repo, `the child works in ${child.worktree}, not a new worktree`);
    const greeting = readFileSync(join(child.worktree, "greeting.txt"), "utf8");
    assert(greeting.includes(secret), `greeting.txt holds ${greeting}`);
    const logged = execFileSync("git", ["log", "--oneline", "-1"], { cwd: child.worktree }).toString();
    assert(/add greeting/.test(logged), `the last commit is ${logged}`);
    assert(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trim() === "", "the parent's checkout was touched");
    const listed = await must(userToken(), "list_peers", {});
    assert(listed.some((s) => s.id === child.id && s.kind === "session"), `list_peers: ${JSON.stringify(listed)}`);
    return `report: ${readFileSync(out, "utf8").trim().slice(0, 80)}`;
  },

  // A bot starts a session and ends its turn; the report wakes it.
  async b(provider) {
    const bot = await rpc("session_create", {
      workspaceId: workspace.id, kind: "bot", name: `Boss ${provider}`, provider: "claude", model: MODELS.claude,
      description: "You hand arithmetic to other CLIs and pass on what they find.", autonomy: "full",
    });
    await rpc("turn_start", {
      sessionId: bot.id, cwd: repo,
      text: `Use Crew's start_session with provider "${provider}", model "${MODELS[provider]}" and prompt "What is 17 times 23? Reply with the number only." Do not wait for it: end your turn right after starting it. Its report wakes you; then tell me the number it reported, written as RESULT: <number>.`,
    });
    const until = Date.now() + 15 * 60_000;
    let text = "";
    let tail;
    while (Date.now() < until) {
      await sleep(3000);
      tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 200 });
      text = tail.blocks.filter((b) => b.role === "assistant").map((b) => b.text).join("\n");
      if (!tail.working && /RESULT:\s*\**391/.test(text)) break;
    }
    assert(/RESULT:\s*\**391/.test(text), `the bot said: ${text.slice(-300)}`);
    const sessions = await rpc("session_list", { workspaceId: workspace.id });
    const child = sessions.find((s) => s.kind === "child" && s.parentId === bot.id);
    assert(child && child.provider === provider, "no child of the bot's");
    const woken = tail.blocks.find((b) => b.role === "user" && b.fromBot?.id === child.id);
    assert(woken, "the report never came in as a turn of its own");
    return `woken by its report; RESULT: 391`;
  },

  // A bot starts a session with wait and gets the report in the same turn;
  // the report does not wake it a second time.
  async w(provider) {
    const bot = await rpc("session_create", {
      workspaceId: workspace.id, kind: "bot", name: `Waiter ${provider}`, provider: "claude", model: MODELS.claude,
      description: "You hand arithmetic to other CLIs and pass on what they find.", autonomy: "full",
    });
    await rpc("turn_start", {
      sessionId: bot.id, cwd: repo,
      text: `Use Crew's start_session with provider "${provider}", model "${MODELS[provider]}", wait true and prompt "What is 19 times 21? Reply with the number only." Then tell me the number it reported, written as RESULT: <number>.`,
    });
    const until = Date.now() + 15 * 60_000;
    let tail;
    while (Date.now() < until) {
      await sleep(3000);
      tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 200 });
      if (!tail.working && tail.blocks.some((b) => b.role === "assistant" && /RESULT:\s*\**399/.test(b.text))) break;
    }
    assert(tail.blocks.some((b) => b.role === "assistant" && /RESULT:\s*\**399/.test(b.text)), `the bot said: ${JSON.stringify(tail.blocks.slice(-3))}`);
    await sleep(5000);
    tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 200 });
    const turns = tail.blocks.filter((b) => b.role === "user");
    assert(turns.length === 1 && !turns.some((b) => b.fromBot), `the report woke it as well: ${turns.length} turns`);
    return "reported within the turn; not woken again";
  },

  // One parent, children of every provider, each reports.
  async c() {
    const shell = await terminal("c-parent");
    const words = { claude: "ALPHA", codex: "BRAVO", opencode: "CHARLIE", cursor: "DELTA" };
    const ids = {};
    for (const provider of PROVIDERS.filter(installed)) {
      ids[provider] = await start(shell.token, provider, `Reply with the word ${words[provider]} and nothing else.`);
    }
    const events = await waitAll(shell.token, Object.values(ids));
    const order = events.map((event) => Object.keys(ids).find((p) => ids[p] === event.id));
    for (const [provider, id] of Object.entries(ids)) {
      const mine = events.filter((event) => event.id === id);
      assert(mine.length === 1, `${provider} answered ${mine.length} times`);
      assert(mine[0].report.toUpperCase().includes(words[provider]), `${provider} reported ${mine[0].report}`);
    }
    return `order: ${order.join(" → ")}`;
  },

  // A wait that runs out says the child is still running and leaves it be.
  async d(provider) {
    const shell = await terminal(`d-${provider}`);
    const out = await must(shell.token, "start_session", {
      provider, model: MODELS[provider], prompt: "Run the shell command `sleep 25`, then reply with the word DONE.", wait: true, timeout_s: 5,
    });
    assert(out.status === "running" && /read_session/.test(out.note), `the first wait answered ${JSON.stringify(out)}`);
    const first = await waitEvent(shell.token, out.id, 600);
    assert(/DONE/i.test(first.sessions[0].report), `turn 1 reported ${first.sessions[0].report}`);
    return "running after 5 s, then reported";
  },

  // A message queues behind a busy turn; an idle session takes a new turn in
  // the same conversation and remembers the first.
  async e(provider) {
    const shell = await terminal(`e-${provider}`);
    const code = word("NUMBAT");
    const id = await start(shell.token, provider, `Remember this code word: ${code}. Then run the shell command \`sleep 12\` and reply with the word READY.`);
    const queued = await must(shell.token, "send_message", { to: id, text: "What code word did I give you at the start? Reply with the code word only." });
    assert(queued.delivery === "queued", `the busy session took it at once: ${JSON.stringify(queued)}`);
    const first = await waitEvent(shell.token, id);
    assert(/READY/i.test(first.sessions[0].report), `turn 1 reported ${first.sessions[0].report}`);
    const second = await waitEvent(shell.token, id, 600, first.cursors[id]);
    assert(second.sessions[0].report.includes(code), `the queued turn reported ${second.sessions[0].report}`);
    await untilStatus(id, ["idle"]);
    const idle = await must(shell.token, "send_message", { to: id, text: "Say the code word once more, all in lowercase, and nothing else." });
    assert(idle.delivery === "started", `the idle session did not start a turn: ${JSON.stringify(idle)}`);
    const third = await waitEvent(shell.token, id);
    assert(third.sessions[0].report.includes(code.toLowerCase()), `turn 3 reported ${third.sessions[0].report}`);
    return `queued, then remembered ${code} across turns`;
  },

  // A command left running in the background: the tray lists it while the
  // child's turn waits on it, its output is read from the CLI, and Stop ends
  // it (Claude's stop_task, Codex's backgroundTerminals/terminate).
  async t(provider) {
    if (provider !== "claude" && provider !== "codex") return "n/a: Claude and Codex children only";
    const shell = await terminal(`t-${provider}`);
    const job =
      provider === "claude"
        ? "Use the Bash tool with run_in_background: true to run exactly `echo tick; sleep 120; echo tock`. Do not wait for it and do not check on it: reply with the word STARTED right away."
        : "Run exactly `echo tick; sleep 120; echo tock` as one command and let it keep running: do not wait for it to finish. Then wait 30 seconds with `sleep 30` and reply with the word STARTED.";
    const id = await start(shell.token, provider, job);
    const until = Date.now() + 240_000;
    let listed;
    while (Date.now() < until) {
      listed = await rpc("background_list", { sessionId: id });
      if (listed.commands.some((c) => c.state === "running")) break;
      await sleep(1000);
    }
    const running = listed?.commands.find((c) => c.state === "running");
    assert(running, `nothing listed as running: ${JSON.stringify(listed)}`);
    assert(running.kind === "shell" && /sleep 120/.test(running.command), `listed ${JSON.stringify(running)}`);
    assert(listed.live, "the list says its CLI is gone");
    assert(events.some((e) => e.event === "background-changed" && e.payload.sessionId === id), "no background-changed event");
    // Claude reads a running command's output; Codex's app server streams
    // none for these, and hands it over when the command ends.
    let output = { output: "" };
    for (let i = 0; provider === "claude" && i < 10 && !/tick/.test(output.output); i++) {
      output = await rpc("background_output", { sessionId: id, id: running.id });
      await sleep(1000);
    }
    if (provider === "claude") assert(/tick/.test(output.output), `output: ${JSON.stringify(output)}`);
    await rpc("background_stop", { sessionId: id, id: running.id });
    const stopped = (await rpc("background_list", { sessionId: id })).commands.find((c) => c.id === running.id);
    assert(stopped.state === "stopped", `after Stop it is ${stopped.state}`);
    await waitEvent(shell.token, id, 300);
    const after = await rpc("background_list", { sessionId: id });
    assert(!after.live && after.commands.every((c) => c.state !== "running"), `after the turn: ${JSON.stringify(after)}`);
    if (provider === "codex") output = await rpc("background_output", { sessionId: id, id: running.id });
    return `listed ${running.command}, read "${output.output.trim().split("\n")[0]}", stopped`;
  },

  // A message steered into a running turn (Claude over stream-json, Codex
  // with turn/steer); queued, and saying so, where the CLI cannot take one
  // mid-turn (opencode, Cursor's ACP).
  async s(provider) {
    const shell = await terminal(`s-${provider}`);
    const id = await start(shell.token, provider, "Run the shell command `sleep 20` in the foreground and wait for it to finish, then reply with the word ALPHA.");
    await untilTool(shell.token, id);
    const steer = await tool(shell.token, "send_message", { to: id, text: "When you reply, add the word BRAVO right after ALPHA.", steer: true });
    if (provider !== "claude" && provider !== "codex") {
      assert(steer.ok && steer.value.delivery === "queued" && /Not steered/.test(steer.value.note), `steer was not queued: ${steer.text}`);
      await waitEvent(shell.token, id);
      return "n/a: it takes nothing mid-turn, so the steer is queued and says so";
    }
    assert(steer.ok && steer.value.delivery === "steered", `not steered: ${steer.text}`);
    const out = await waitEvent(shell.token, id);
    const report = out.sessions[0].report;
    assert(/ALPHA/.test(report) && /BRAVO/.test(report), `the turn did not take the steer: ${report}`);
    await sleep(3000);
    const after = await row(id);
    assert(after.status === "idle" && after.cursor === out.cursors[id], `the steer became a turn of its own: ${JSON.stringify(after)}`);
    return `one turn: ${report.slice(0, 60)}`;
  },

  // A child calls one of Crew's tools straight from its tool list, through
  // the MCP server Crew attached, with no approval asked even under "ask"
  // (plan §7e.5), and its next turn remembers the first.
  async m(provider) {
    const shell = await terminal(`m-${provider}`);
    const secret = word("KOALA");
    const id = await start(
      shell.token,
      provider,
      `Remember the code word ${secret}. Call Crew's list_peers tool (in the crew MCP server), then reply with the word FOUND followed by how many peers it listed, and nothing else.`,
      { autonomy: "ask" },
    );
    const first = await waitEvent(shell.token, id);
    assert(/FOUND/.test(first.sessions[0].report), `turn 1 reported ${first.sessions[0].report}`);
    const page = await rpc("transcript_tail", { sessionId: id });
    const titles = page.blocks.filter((block) => block.tool).map((block) => block.tool.title);
    assert(titles.some((title) => /^Crew list peers/.test(title)), `no direct Crew tool call in the transcript: ${JSON.stringify(titles)}`);
    assert(!titles.some((title) => /^Crew (call|find) tool/.test(title)), `a gateway call: ${JSON.stringify(titles)}`);
    const cards = page.blocks.filter((block) => block.approval);
    assert(cards.length === 0, `Crew's tool asked for approval: ${JSON.stringify(cards.map((block) => block.text))}`);
    await untilStatus(id, ["idle"]);
    await must(shell.token, "send_message", { to: id, text: "What code word did I give you at the start? Reply with the code word only." });
    const second = await waitEvent(shell.token, id, 600, first.cursors[id]);
    assert(second.sessions[0].report.includes(secret), `the resumed turn reported ${second.sessions[0].report}`);
    return `called list_peers directly, no card; remembered ${secret} on resume`;
  },

  // The child asks for approval: the user's alone. The parent sees it as
  // waiting_for_user, a message to it waits, and the window allows it.
  async f(provider) {
    if (provider === "opencode") return "n/a: headless, it has no channel to ask Crew for approval";
    if (provider === "cursor" && !process.env.CURSOR_CONFIG_DIR) {
      return "n/a: set CURSOR_CONFIG_DIR to a Cursor config with approvalMode allowlist; the default runs everything";
    }
    const target = (name) => (provider === "codex" ? join(dataDir, name) : join(repo, name));
    const job = (name) =>
      provider === "codex"
        ? `Run exactly this shell command: touch ${target(name)} — it is outside your workspace, so ask for escalated permissions to run it. Then reply DONE.`
        : provider === "cursor"
          ? `Use your shell tool to run exactly this command: touch ${name} — then reply DONE.`
          : `Use your Bash tool to run exactly this command: touch ${name} — then reply DONE.`;
    const shell = await terminal(`f-full-${provider}`);
    const id = await start(shell.token, provider, job("approved.txt"), { autonomy: "ask" });
    const asked = await waitEvent(shell.token, id);
    assert(asked.sessions[0].event === "needs-input" && asked.sessions[0].request?.kind === "approval", `it never asked: ${JSON.stringify(asked)}`);
    const peers = await must(shell.token, "list_peers", {});
    assert(peers.find((p) => p.id === id)?.status === "waiting_for_user", `list_peers: ${JSON.stringify(peers)}`);
    const sent = await must(shell.token, "send_message", { to: id, text: "Once it is done, also say OK." });
    assert(sent.delivery === "queued", `a message went in over the approval: ${JSON.stringify(sent)}`);
    await rpc("turn_respond", { sessionId: id, requestId: asked.sessions[0].request.request_id, decision: "allow" });
    const done = await waitEvent(shell.token, id);
    assert(done.sessions[0].event === "turn", `after allowing: ${JSON.stringify(done)}`);
    assert(existsSync(target("approved.txt")), "the allowed command did not run");
    rmSync(target("approved.txt"), { force: true });
    await waitEvent(shell.token, id);
    return "waiting_for_user; message queued; allowed by the user";
  },

  // The child asks a question with its question tool: a wait returns it
  // early, and the parent answers with send_message.
  async q(provider) {
    if (provider !== "claude" && provider !== "codex") return "n/a: its question tool is not offered headless";
    const shell = await terminal(`q-${provider}`);
    const ask = provider === "claude" ? "your AskUserQuestion tool" : "your request_user_input tool";
    const out = await must(shell.token, "start_session", {
      provider, model: MODELS[provider], wait: true, timeout_s: 300,
      prompt: `Use ${ask} to ask me which color I prefer, with exactly the options Red and Blue. Do not guess. Then reply with the word COLOR followed by my answer.`,
    });
    assert(out.status === "question", `it did not stop on a question: ${JSON.stringify(out)}`);
    const answered = await must(shell.token, "send_message", { to: out.id, text: "Blue" });
    assert(answered.delivery === "answered", `not answered: ${JSON.stringify(answered)}`);
    const done = await waitEvent(shell.token, out.id, 300);
    assert(/BLUE/i.test(done.sessions[0].report), `it reported ${done.sessions[0].report}`);
    return `question: ${out.questions?.[0]?.question?.slice(0, 50)} → ${done.sessions[0].report.slice(0, 40)}`;
  },

  // A bot's child asks a question: the question wakes the bot, which
  // answers it with send_message; the report wakes it again.
  async p(provider) {
    if (provider !== "claude" && provider !== "codex") return "n/a: its question tool is not offered headless";
    const bot = await rpc("session_create", {
      workspaceId: workspace.id, kind: "bot", name: `Asker ${provider}`, provider: "claude", model: MODELS.claude,
      description: "You start sessions for the user. When one of them asks which color to use, the answer is Blue.", autonomy: "full",
    });
    const ask = provider === "claude" ? "your AskUserQuestion tool" : "your request_user_input tool";
    await rpc("turn_start", {
      sessionId: bot.id, cwd: repo,
      text: `Use Crew's start_session with provider "${provider}", model "${MODELS[provider]}" and this prompt: "Use ${ask} to ask which color to use, with exactly the options Red and Blue. Do not guess. Then reply with the word COLOR followed by the answer." Do not wait for it: end your turn. If it asks you something, answer it with send_message. When its report arrives, tell me what it reported, as RESULT: <report>.`,
    });
    const until = Date.now() + 10 * 60_000;
    let tail;
    while (Date.now() < until) {
      await sleep(3000);
      tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 300 });
      if (!tail.working && tail.blocks.some((b) => b.role === "assistant" && /COLOR\W*Blue/i.test(b.text))) break;
    }
    const child = (await rpc("session_list", { workspaceId: workspace.id })).find((s) => s.kind === "child" && s.parentId === bot.id);
    assert(child, "no child");
    const letters = tail.blocks.filter((b) => b.role === "user" && b.fromBot?.id === child.id);
    assert(letters.length >= 2, `the bot was not woken by the question and the report: ${letters.length} letters`);
    const answered = tail.blocks.find((b) => b.tool?.detail?.kind === "message" && b.tool.detail.to === child.id);
    assert(answered, "the bot did not answer with send_message");
    assert(tail.blocks.some((b) => b.role === "assistant" && /COLOR\W*Blue/i.test(b.text)), `the bot said: ${JSON.stringify(tail.blocks.slice(-2))}`);
    return `question woke it; answered "${answered.tool.detail.text.slice(0, 20)}"; report woke it`;
  },

  // A bot on full autonomy, an ask child that needs a command approved: the
  // approval wakes the bot, which allows it with send_message; the child
  // carries on and its report wakes the bot again. The user's card stays.
  async v(provider) {
    if (provider !== "claude" && provider !== "codex") return "n/a: Claude and Codex children only";
    const bot = await rpc("session_create", {
      workspaceId: workspace.id, kind: "bot", name: `Lead ${provider}`, provider: BOT, model: MODELS[BOT],
      description: "You start sessions for the user. Creating files in this repository is fine.", autonomy: "full",
    });
    const file = `approved-v-${provider}.txt`;
    const job = askJob(provider, file);
    await rpc("turn_start", {
      sessionId: bot.id, cwd: repo,
      text: `Use Crew's start_session with provider "${provider}", model "${MODELS[provider]}", autonomy "ask" and this prompt: ${JSON.stringify(job.prompt)} Do not wait for it: end your turn right after starting it. When its report arrives, tell me what it reported, as RESULT: <report>.`,
    });
    const until = Date.now() + 10 * 60_000;
    let tail;
    while (Date.now() < until) {
      await sleep(3000);
      tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 300 });
      if (!tail.working && tail.blocks.some((b) => b.role === "assistant" && /RESULT:[\s\S]*DONE/i.test(b.text))) break;
    }
    const child = (await rpc("session_list", { workspaceId: workspace.id })).find((s) => s.kind === "child" && s.parentId === bot.id);
    assert(child, "no child");
    const letters = tail.blocks.filter((b) => b.role === "user" && b.fromBot?.id === child.id);
    assert(letters.some((b) => /It wants to use/.test(b.text)), `the approval never woke the bot: ${JSON.stringify(letters.map((b) => b.text.slice(0, 80)))}`);
    const decided = tail.blocks.find((b) => b.tool?.detail?.kind === "message" && b.tool.detail.toId === child.id);
    assert(decided, `the bot did not decide with send_message: ${JSON.stringify(tail.blocks.filter((b) => b.tool).map((b) => b.tool.title))}`);
    const childTail = await rpc("transcript_tail", { sessionId: child.id, limit: 300 });
    const card = childTail.blocks.find((b) => b.approval);
    assert(card && /allow/i.test(String(card.approval.decided)), `the card: ${JSON.stringify(card?.approval)}`);
    const note = childTail.blocks.find((b) => /allowed:/.test(b.text ?? ""));
    assert(note, "no note of who decided");
    assert(job.done(child), "the allowed command did not run");
    assert(tail.blocks.some((b) => b.role === "assistant" && /RESULT:[\s\S]*DONE/i.test(b.text)), `the bot said: ${JSON.stringify(tail.blocks.slice(-2).map((b) => b.text))}`);
    return `approval woke it; ${note.text.slice(0, 60)}; report woke it`;
  },

  // A bot on ask autonomy could not run the command itself: no letter, the
  // card stays with the user, who allows it; the report then wakes the bot.
  async x(provider) {
    if (provider !== BOT) return "n/a: once is enough";
    const bot = await rpc("session_create", {
      workspaceId: workspace.id, kind: "bot", name: "Careful lead", provider: BOT, model: MODELS[BOT],
      description: "You start sessions for the user.", autonomy: "ask",
    });
    const file = "approved-x.txt";
    const job = askJob(provider, file);
    await rpc("turn_start", {
      sessionId: bot.id, cwd: repo,
      text: `Use Crew's start_session with provider "${provider}", model "${MODELS[provider]}" and this prompt: ${JSON.stringify(job.prompt)} Do not wait for it: end your turn right after starting it. When its report arrives, reply RESULT: <report>.`,
    });
    let child;
    for (let i = 0; i < 200 && !child; i++) {
      await sleep(3000);
      child = (await rpc("session_list", { workspaceId: workspace.id })).find((s) => s.kind === "child" && s.parentId === bot.id);
    }
    assert(child, "no child");
    await untilStatus(child.id, ["needs-input"], 300);
    await sleep(15_000);
    let tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 300 });
    assert(!tail.blocks.some((b) => b.role === "user" && b.fromBot?.id === child.id), "the bot was woken for an approval it could not give");
    const now = await describe(await row(child.id));
    assert(now.request?.kind === "approval", `the child waits on ${JSON.stringify(now.request)}`);
    await rpc("turn_respond", { sessionId: child.id, requestId: now.request.request_id, decision: "allow" });
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      await sleep(3000);
      tail = await rpc("transcript_tail", { sessionId: bot.id, limit: 300 });
      if (!tail.working && tail.blocks.some((b) => b.role === "assistant" && /RESULT:/i.test(b.text))) break;
    }
    assert(job.done(child), "the allowed command did not run");
    const letters = tail.blocks.filter((b) => b.role === "user" && b.fromBot?.id === child.id);
    assert(letters.length === 1 && !/It wants to use/.test(letters[0].text), `letters: ${JSON.stringify(letters.map((b) => b.text.slice(0, 60)))}`);
    return "no letter; the user's card allowed it; the report woke the bot";
  },

  // Stopped mid-turn, the transcript stays.
  async g(provider) {
    const shell = await terminal(`g-${provider}`);
    const id = await start(shell.token, provider, "Run the shell command `sleep 90`, then reply with the word DONE.");
    await untilTool(shell.token, id);
    const stopped = await must(shell.token, "stop_session", { session: id });
    assert(stopped.status === "exited", `stopped: ${JSON.stringify(stopped)}`);
    const read = await must(shell.token, "read_session", { session: id, include_tools: true });
    assert(/sleep 90/.test(read.text) && /Stopped by/.test(read.text), read.text);
    assert(!/\[assistant\]\W*DONE\W*$/m.test(read.text), "the turn had finished before the stop");
    const sent = await tool(shell.token, "send_message", { to: id, text: "more" });
    assert(!sent.ok && /exited/.test(sent.text), "an exited session took a message");
    assert((await row(id)).status === "exited", "not exited");
    return "exited; transcript kept and readable";
  },

  // The limits: depth, the cap, autonomy, ownership.
  async h(provider) {
    const shell = await terminal(`h-${provider}`);
    const file = join(dataDir, `child-token-${provider}`);
    const id = await start(shell.token, provider, `Run exactly this shell command and nothing else: printf %s "$CREW_TOKEN" > ${file} — then reply DONE.`);
    await waitEvent(shell.token, id);
    assert(existsSync(file), "the child never wrote its token");
    const childToken = readFileSync(file, "utf8").trim();
    const listed = await bridge(childToken, "tools/list");
    const names = listed.result.tools.map((t) => t.name);
    assert(names.includes("send_message") && names.includes("list_peers") && !names.includes("start_session"), `a child is listed: ${names}`);
    const call = await tool(childToken, "start_session", { provider: "claude", prompt: "x" });
    assert(!call.ok && /Unknown tool/.test(call.text), `a child ran start_session: ${call.text}`);
    // The cap: three more make four live; a fifth is refused.
    const more = [];
    for (let n = 0; n < 3; n++) more.push(await start(shell.token, provider, "Reply with the word OK."));
    const fifth = await tool(shell.token, "start_session", { provider, model: MODELS[provider], prompt: "Reply with OK." });
    assert(!fifth.ok && /4 live sessions/.test(fifth.text), `a fifth started: ${fifth.text}`);
    // Autonomy never grows.
    const careful = await terminal(`h-ask-${provider}`);
    await setAutonomy(careful, "ask");
    const full = await tool(careful.token, "start_session", { provider, model: MODELS[provider], prompt: "x", autonomy: "full" });
    assert(!full.ok && /cannot have full/.test(full.text), `an ask parent made a full child: ${full.text}`);
    // Nobody else drives it.
    const stranger = await terminal(`h-stranger-${provider}`);
    for (const [name, args] of [
      ["read_session", { session: id }],
      ["send_message", { to: id, text: "hi" }],
      ["stop_session", { session: id }],
    ]) {
      const out = await tool(stranger.token, name, args);
      assert(!out.ok && /not by you/.test(out.text), `${name} as a stranger: ${out.text}`);
    }
    await waitAll(shell.token, more);
    for (const other of [id, ...more]) await must(shell.token, "stop_session", { session: other });
    return `child tools: ${names.join(", ")}; 5th refused; full refused; stranger refused ×3`;
  },

  // The CLI dies mid-turn: an error.
  async i(provider) {
    const shell = await terminal(`i-${provider}`);
    const id = await start(shell.token, provider, "Run the shell command `sleep 60`, then reply with the word DONE.", { worktree: "new" });
    await untilTool(shell.token, id);
    const pid = cliIn(await cwdOf(await row(id)));
    assert(pid, "no CLI process for the session");
    process.kill(-pid, "SIGKILL");
    const out = await waitEvent(shell.token, id, 120);
    assert(out.sessions[0].event === "error" && out.sessions[0].status === "error", JSON.stringify(out));
    return `error: ${out.sessions[0].outcome.slice(0, 70)}`;
  },

  // crewd restarts with sessions alive.
  async j(provider) {
    const shell = await terminal(`j-${provider}`);
    const idle = await start(shell.token, provider, "Reply with the word KEPT.");
    const kept = await waitEvent(shell.token, idle);
    assert(kept.sessions[0].event === "turn", `the first session's turn failed before any restart: ${JSON.stringify(kept.sessions[0])}`);
    const busy = await start(shell.token, provider, "Run the shell command `sleep 20`, then reply with the word RESTARTED.");
    await untilTool(shell.token, busy);
    const before = (await row(busy)).cursor;
    await stopDaemon();
    await startDaemon();
    // The terminal's process went with the daemon; the window starts it again
    // and it gets a new token for the same session.
    const again = await reopen(shell);
    const listed = await must(again.token, "list_peers", {});
    assert(listed.some((s) => s.id === idle && s.status === "idle"), `the idle one: ${JSON.stringify(listed)}`);
    const read = await must(again.token, "read_session", { session: idle });
    assert(/KEPT/i.test(read.text), "the idle one's transcript is gone");
    assert(/KEPT/i.test(kept.sessions[0].report), "");
    const out = await waitEvent(again.token, busy, 600, before);
    assert(out.sessions[0].event === "turn" && /RESTARTED/i.test(out.sessions[0].report), JSON.stringify(out));
    const whole = await must(again.token, "read_session", { session: busy });
    assert(/Crew restarted mid-turn/.test(whole.text), whole.text);
    return "idle kept; mid-turn resumed and reported";
  },

  // A handoff, peers, processes.
  async k() {
    const shell = await terminal("k-parent");
    const peers = await must(shell.token, "list_peers", {});
    assert(Array.isArray(peers), "list_peers");
    const branch = word("k-branch-");
    const handed = await must(shell.token, "start_session", { owner: "user", worktree: branch, prompt: "Nothing to do; this is a test." });
    assert(handed.owner === "user" && handed.branch === branch && existsSync(handed.worktree), `no handoff: ${JSON.stringify(handed)}`);
    const made = await row(handed.id);
    assert(made.kind === "terminal" && made.worktree === handed.worktree && made.handedOffBy === shell.id && !made.parentId, JSON.stringify(made));
    const waited = await tool(shell.token, "start_session", { owner: "user", wait: true, prompt: "x" });
    assert(!waited.ok && /nothing to wait for/.test(waited.text), waited.text);
    await must(shell.token, "save_process", { name: "k-proc", command: "echo READY-K; sleep 300" });
    await must(shell.token, "control_process", { process: "k-proc", action: "start" });
    const ready = await must(shell.token, "wait_for_log", { process: "k-proc", pattern: "READY-K", timeout_s: 30 });
    assert(ready.result === "matched", JSON.stringify(ready));
    const logs = await must(shell.token, "read_logs", { process: "k-proc" });
    assert(/READY-K/.test(logs.text), logs.text);
    await must(shell.token, "control_process", { process: "k-proc", action: "stop" });
    return `handed off ${made.name} on ${branch} (handedOffBy ${made.handedOffBy.slice(0, 8)}); list_peers; processes`;
  },
};

/** A terminal's process started again on the same session, as the window does after a restart. */
async function reopen(shell) {
  const file = join(dataDir, `token-${shell.id}`);
  rmSync(file, { force: true });
  await rpc("pty_spawn", {
    id: shell.id, cwd: repo, cols: 80, rows: 24, session: shell.id,
    command: ["/bin/sh", "-c", `printf %s "$CREW_TOKEN" > '${file}'; exec sleep 100000`],
  });
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(50);
  await sleep(100);
  return { ...shell, token: readFileSync(file, "utf8").trim() };
}

// --- the run ----------------------------------------------------------------

const ONCE = new Set(["c", "k"]);
const results = {};
const record = (scenario, provider, outcome) => {
  results[scenario] ??= {};
  results[scenario][provider] = outcome;
  log(`${scenario} × ${provider}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ""}`);
};

await startDaemon();
workspace = await rpc("workspace_create", { name: "drive", path: repo });
const usable = PROVIDERS.filter((provider) => {
  const there = installed(provider);
  if (!there) log(`${provider}: not installed`);
  return there;
});
// The restart goes last: it takes the daemon down under everything else.
for (const scenario of SCENARIOS.filter((s) => s !== "j").concat(SCENARIOS.includes("j") ? ["j"] : [])) {
  const run = scenarios[scenario];
  if (!run) continue;
  if (ONCE.has(scenario)) {
    try {
      const note = await run();
      for (const provider of usable) record(scenario, provider, { status: "pass", note });
    } catch (error) {
      for (const provider of usable) record(scenario, provider, { status: "FAIL", note: String(error.message ?? error).slice(0, 300) });
    }
    continue;
  }
  for (const provider of usable) {
    try {
      const note = await run(provider);
      record(scenario, provider, note?.startsWith("n/a") ? { status: "n/a", note: note.slice(5) } : { status: "pass", note });
    } catch (error) {
      record(scenario, provider, { status: "FAIL", note: String(error.message ?? error).slice(0, 300) });
    }
  }
}
for (const provider of ALL.filter((p) => !installed(p))) {
  for (const scenario of SCENARIOS) record(scenario, provider, { status: "not available", note: "CLI not installed" });
}
await stopDaemon();
rmSync(worktreesHome, { recursive: true, force: true });

console.log("\n| Scenario | " + ALL.join(" | ") + " |");
console.log("| --- |" + ALL.map(() => " --- |").join(""));
for (const scenario of SCENARIOS) {
  console.log(`| ${scenario} | ` + ALL.map((p) => results[scenario]?.[p]?.status ?? "—").join(" | ") + " |");
}
const out = process.env.RESULTS ?? join(dataDir, "results.json");
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nresults: ${out}`);
const failed = Object.values(results).some((row) => Object.values(row).some((cell) => cell.status === "FAIL"));
if (!KEEP && !failed) rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
