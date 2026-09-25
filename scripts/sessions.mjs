// Drives terminal sessions end to end: real provider CLIs in crewd's PTYs, run
// side by side while the "user" flips between their tabs, the way the app does.
// Each one gets a prompt that keeps it busy through a long tool call, and the
// tab indicator, the provider session binding and the title are checked
// against what the CLI actually did.
//
//   node scripts/sessions.mjs
//   PROVIDERS=claude,cursor node scripts/sessions.mjs
//
// The indicator is the app's own TerminalActivity, fed the same signals the
// terminal view feeds it. Build the daemon first: cargo build -p crewd.
// Needs Node 23.6+ (for the TypeScript import) and the CLIs logged in; opencode
// runs on a free model.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalActivity, titleName } from "../src/lib/terminalStatus.ts";

const REPO = new URL("..", import.meta.url).pathname;
const PROVIDERS = (process.env.PROVIDERS ?? "claude,opencode,cursor").split(",");
const SLEEP = Number(process.env.SLEEP ?? 15);
/** Joined by the model, so the prompt's own echo never matches. */
const ANSWER = "PINEAPPLE";
const PROMPT = `Use your shell tool to run exactly this command: sleep ${SLEEP} . After it finishes, reply with one word: PINE and APPLE joined together, in capitals.`;
/** How often the "user" moves to another tab while the turns run. */
const SWITCH_MS = 1700;
/** Mirrors the terminal view: output reaches the indicator at most this often. */
const ACTIVITY_INTERVAL = 400;

/** The hooks src/lib/sessionCommand.ts hands Claude. */
function claudeHooks(crewId) {
  const at = (file) => `"$CREW_CLAUDE_BIND_DIR/${crewId}.${file}"`;
  const bind = `if [ -n "$CREW_CLAUDE_BIND_DIR" ]; then f="$CREW_CLAUDE_BIND_DIR/${crewId}.$(date +%s)-$$"; cat > "$f.tmp" && mv "$f.tmp" "$f.start"; fi`;
  const ask = `if [ -n "$CREW_CLAUDE_BIND_DIR" ]; then cat > ${at("attention.tmp")} && mv ${at("attention.tmp")} ${at("attention")}; fi`;
  return {
    SessionStart: [{ hooks: [{ type: "command", command: bind }] }],
    Notification: [{ matcher: "permission_prompt|elicitation_dialog", hooks: [{ type: "command", command: ask }] }],
  };
}

const LAUNCH = {
  claude: {
    model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001",
    // The app's argv (src/lib/sessionCommand.ts), plus leave to run the one command.
    argv: (session, model, resume) => [
      "claude",
      "--settings",
      JSON.stringify({ hooks: claudeHooks(session.id) }),
      ...(resume ? ["--resume", session.providerSessionId ?? session.id] : ["--session-id", session.id, "--model", model]),
      "--allowedTools",
      "Bash(sleep:*)",
    ],
  },
  opencode: {
    model: process.env.OPENCODE_MODEL ?? "opencode/ling-3.0-flash-fin-free",
    argv: (session, model, resume) => ["opencode", ...(resume ? ["--session", session.providerSessionId] : []), "-m", model],
  },
  cursor: {
    model: process.env.CURSOR_MODEL ?? "",
    argv: (session, model) => ["cursor-agent", "--resume", session.providerSessionId, ...(model ? ["--model", model] : [])],
  },
};

const dataDir = mkdtempSync(join(tmpdir(), "crew-sessions-"));
// Real path: the CLIs file their sessions under the folder they resolve to.
const workDir = join(realpathSync(dataDir), "work");
mkdirSync(workDir);

const daemon = spawn(join(REPO, "target/debug/crewd"), [`--data-dir=${dataDir}`], { stdio: ["pipe", "pipe", "pipe"] });
daemon.stderr.on("data", (chunk) => {
  if (process.env.VERBOSE) process.stderr.write(`[crewd] ${chunk}`);
});
const info = await new Promise((resolve, reject) => {
  let buffer = "";
  daemon.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
  });
  daemon.on("exit", (code) => reject(new Error(`crewd exited ${code}`)));
});

const ws = new WebSocket(info.url);
ws.binaryType = "arraybuffer";
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.send(JSON.stringify({ auth: info.token }));

let nextId = 1;
const pending = new Map();
const streams = new Map();
ws.addEventListener("message", (message) => {
  if (typeof message.data !== "string") {
    const bytes = new Uint8Array(message.data);
    const stream = new DataView(bytes.buffer).getUint32(0, true);
    streams.get(stream)?.(bytes.subarray(4));
    return;
  }
  const parsed = JSON.parse(message.data);
  if (parsed.id !== undefined && pending.has(parsed.id)) {
    const { resolve, reject } = pending.get(parsed.id);
    pending.delete(parsed.id);
    parsed.ok ? resolve(parsed.result) : reject(new Error(parsed.error));
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), 60_000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const log = (...args) => console.log(at(), ...args);

const workspace = await rpc("workspace_create", { name: "sessions", path: workDir });

/** What xterm answers on the app's behalf; some TUIs wait for it. */
function answerQueries(text, write) {
  if (/\x1b\[0?c/.test(text)) write("\x1b[?62;22c");
  if (text.includes("\x1b[6n")) write("\x1b[1;1R");
  if (text.includes("\x1b]11;?")) write("\x1b]11;rgb:1a1a/1a1a/1a1a\x07");
  if (text.includes("\x1b]10;?")) write("\x1b]10;rgb:e8e8/eeee/f2f2\x07");
  if (text.includes("\x1b[?u")) write("\x1b[?0u");
}

const strip = (text) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "");

async function open(provider) {
  let session = await rpc("session_create", {
    workspaceId: workspace.id,
    kind: "terminal",
    name: provider,
    provider,
    model: LAUNCH[provider].model,
    description: "",
    autonomy: "ask",
  });
  if (provider === "cursor") session = { ...session, providerSessionId: await rpc("session_provider_create", { id: session.id }) };

  const tab = { provider, session, status: session.status, samples: [], answeredAt: null, promptedAt: null };
  await launch(tab, false);
  return tab;
}

/** Spawns the tab's CLI in a PTY and wires it the way the terminal view does. */
async function launch(tab, resume) {
  const { provider, session } = tab;
  Object.assign(tab, { statuses: [], titles: [], screen: "", startedAt: Date.now(), lastActivity: 0, osc: "", watched: false });
  const argv = LAUNCH[provider].argv(session, LAUNCH[provider].model, resume);
  tab.activity = new TerminalActivity(tab.status, false, {
    report: (status) => {
      tab.status = status;
      tab.statuses.push({ t: Date.now(), status });
      log(`${provider.padEnd(8)} → ${status}`);
      void rpc("session_set_status", { id: session.id, status }).catch(() => {});
    },
  });

  const streamId = await rpc("pty_spawn", { id: session.id, cwd: workDir, command: argv, cols: 120, rows: 40 });
  const write = (data) => rpc("pty_write", { id: session.id, data }).catch(() => {});
  tab.write = write;
  let processed = 0;
  const decoder = new TextDecoder();
  streams.set(streamId, (bytes) => {
    processed += bytes.byteLength;
    void rpc("pty_ack", { id: session.id, processed }).catch(() => {});
    const text = decoder.decode(bytes, { stream: true });
    answerQueries(text, write);
    // Titles may straddle two chunks; xterm would reassemble them.
    const scan = tab.osc + text;
    const titles = [...scan.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)];
    for (const [, title] of titles) {
      if (tab.titles.at(-1) !== title) tab.titles.push(title);
      tab.activity.title(title);
      // As the app does: a new name on the terminal asks for the provider's.
      const name = titleName(title);
      if (name !== tab.osName) {
        tab.osName = name;
        tab.renamedAt = Date.now();
        clearTimeout(tab.nudge);
        tab.nudge = setTimeout(() => void sweep(tab).catch(() => {}), 800);
      }
    }
    const open = scan.lastIndexOf("\x1b]");
    tab.osc = open >= 0 && !/\x07|\x1b\\/.test(scan.slice(open)) ? scan.slice(open) : "";
    if (/\x07/.test(scan.replace(/\x1b\][^\x07]*\x07/g, ""))) tab.activity.bell();
    tab.screen = (tab.screen + strip(text)).slice(-20_000);
    // cursor-agent asks before it works in a folder it has not seen; the temp one is new.
    if (!tab.trusted && tab.screen.includes("Trust this workspace")) {
      tab.trusted = true;
      tab.activity.input();
      void write("a");
    }
    if (!tab.answeredAt && tab.promptedAt && tab.screen.includes(ANSWER)) {
      tab.answeredAt = Date.now();
      log(`${provider.padEnd(8)} answered`);
    }
    const now = Date.now();
    if (now - tab.lastActivity >= ACTIVITY_INTERVAL) {
      tab.lastActivity = now;
      tab.activity.output();
    }
  });
  await rpc("pty_attach", { id: session.id, from: 0 });
  log(`${provider.padEnd(8)} ${resume ? "resumed" : "spawned"} ${session.id}`);
}

/** Pasted, as xterm does once the CLI turned bracketed paste on; all three do. */
async function type(tab, text) {
  tab.activity.input();
  await tab.write(`\x1b[200~${text}\x1b[201~`);
  await sleep(400);
  tab.activity.input();
  await tab.write("\r");
  tab.promptedAt ??= Date.now();
  log(`${tab.provider.padEnd(8)} prompted`);
}

/** Only one tab is in front at a time; `null` puts some other page there. */
function show(tabs, front) {
  for (const tab of tabs) tab.activity.setWatched(tab === front);
  for (const tab of tabs) tab.watched = tab === front;
}

/** The binding and the title the app's sweeps would pick up. */
async function sweep(tab) {
  const { session } = tab;
  if (tab.provider === "claude") {
    const moved = await rpc("session_claude_rebind", { id: session.id });
    if (moved) session.providerSessionId = moved;
  }
  if (tab.provider === "opencode" && !session.providerSessionId) {
    session.providerSessionId = await rpc("session_provider_discover", { id: session.id, cwd: workDir, since: tab.startedAt });
  }
  const name = await rpc("session_sync_title", { id: session.id });
  if (name) {
    session.name = name;
    tab.adoptedAt = Date.now();
    log(`${tab.provider.padEnd(8)} titled "${name}"`);
  }
}

/** Claude's permission prompts reach the tab through its Notification hook. */
async function attention(tab) {
  if (tab.provider !== "claude") return;
  const asked = await rpc("session_claude_attention", { id: tab.session.id });
  if (asked) {
    log(`${tab.provider.padEnd(8)} asks: ${asked}`);
    tab.activity.bell();
  }
}

const tabs = [];
for (const provider of PROVIDERS) tabs.push(await open(provider));
show(tabs, tabs[0]);

// Let every CLI draw its first screen, toasts and all.
await sleep(12_000);

for (const tab of tabs) {
  show(tabs, tab);
  await sleep(300);
  await type(tab, PROMPT);
}

// Flip between the tabs while the turns run, sampling what each indicator says.
const deadline = Date.now() + (SLEEP + 90) * 1000;
let turn = 0;
let lastSwitch = Date.now();
let lastSweep = 0;
while (Date.now() < deadline) {
  const now = Date.now();
  if (now - lastSwitch > SWITCH_MS) {
    lastSwitch = now;
    turn += 1;
    // Every fourth step the user is on some other page altogether. A tab whose
    // turn ended is left alone, so it can be checked for the unread flag.
    const open = tabs.filter((tab) => !tab.answeredAt);
    show(tabs, turn % 4 === 3 || open.length === 0 ? null : open[turn % open.length]);
  }
  // The app's sweep; the nudges above are what should name a session.
  if (now - lastSweep > 15_000) {
    lastSweep = now;
    await Promise.all(tabs.map((tab) => sweep(tab).catch((error) => log(`${tab.provider} sweep: ${error.message}`))));
  }
  await Promise.all(tabs.map((tab) => attention(tab).catch(() => {})));
  for (const tab of tabs) tab.samples.push({ t: now, status: tab.status, watched: tab.watched });
  const settled = tabs.every((tab) => tab.answeredAt && now - tab.answeredAt > 5000);
  const named = tabs.every((tab) => tab.session.name !== tab.provider);
  if (settled && named) break;
  await sleep(100);
}

// Out of sight to the end: a finished turn nobody watched must read unread.
show(tabs, null);
await sleep(3000);
for (const tab of tabs) tab.samples.push({ t: Date.now(), status: tab.status, watched: false });

const results = [];
const check = (provider, name, ok, detail = "") => results.push({ provider, name, ok, detail });

// Claude stops to ask for a command it was not allowed: out of sight, that has
// to read as waiting on you, and answering it has to read as working again.
const claude = tabs.find((tab) => tab.provider === "claude");
if (claude) {
  show(tabs, claude);
  await type(claude, "Use the Bash tool to run exactly: touch approved.txt");
  show(tabs, null);
  let asked = null;
  for (const until = Date.now() + 30_000; Date.now() < until && !asked; await sleep(500)) {
    await attention(claude);
    if (claude.status === "needs-input") asked = Date.now();
  }
  check("claude", "a permission prompt out of sight reads needs-input", Boolean(asked), claude.status);
  show(tabs, claude);
  await sleep(1000);
  claude.activity.input();
  await claude.write("\r");
  const file = join(workDir, "approved.txt");
  for (const until = Date.now() + 30_000; Date.now() < until && !existsSync(file); ) await sleep(300);
  check("claude", "the approved command ran", existsSync(file));
  await sleep(4000);
  check("claude", "an answered prompt no longer reads needs-input", claude.status === "idle", claude.status);
}
for (const tab of tabs) {
  const p = tab.provider;
  const early = tab.statuses.filter((s) => s.t < tab.promptedAt);
  check(p, "the first screen is not a turn", early.length === 0, early.map((s) => s.status).join(" → "));
  check(p, "the turn finished", Boolean(tab.answeredAt), tab.answeredAt ? "" : strip(tab.screen).replace(/\s+/g, " ").slice(-300));
  const firstWorking = tab.statuses.find((s) => s.status === "working" && s.t >= tab.promptedAt);
  check(
    p,
    "it reads working soon after the prompt",
    Boolean(firstWorking) && firstWorking.t - tab.promptedAt < 4000,
    firstWorking ? `${firstWorking.t - tab.promptedAt}ms` : "never",
  );
  if (firstWorking && tab.answeredAt) {
    // The tool call is the long quiet stretch where the old indicator slipped.
    const gaps = tab.samples.filter((s) => s.t > firstWorking.t && s.t < tab.answeredAt - 300 && s.status !== "working");
    check(
      p,
      "it never looks finished mid-turn, watched or not",
      gaps.length === 0,
      gaps.length ? `${gaps.length} samples, first ${gaps[0].status} at +${((gaps[0].t - tab.promptedAt) / 1000).toFixed(1)}s watched=${gaps[0].watched}` : "",
    );
  }
  const end = tab.samples.at(-1);
  const seen = tab.samples.some((s) => s.watched && s.t > tab.answeredAt);
  check(p, "a turn finished out of sight ends unread", seen || end.status === "done", seen ? "watched after" : end.status);
  check(p, "the provider session is bound", Boolean(tab.session.providerSessionId) || p === "claude", tab.session.providerSessionId ?? "");
  check(p, "the provider's title replaced the placeholder", tab.session.name !== p, tab.session.name);
  const lag = tab.adoptedAt && tab.renamedAt ? tab.adoptedAt - tab.renamedAt : null;
  check(p, "the title lands soon after the CLI names it", lag !== null && lag < 3000, lag === null ? "never" : `${lag}ms after "${tab.osName}"`);
  const stored = await rpc("session_get", { id: tab.session.id });
  check(p, "the store holds the title", stored.name === tab.session.name, stored.name);
  if (p === "claude") check(p, "the title says whether it works", tab.titles.some((t) => /^[◐◓◑◒]/u.test(t)), tab.titles.slice(0, 4).join(" | "));
}

console.log("");
let failed = 0;
const printed = results.length;
for (const { provider, name, ok, detail } of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${provider.padEnd(8)} ${name}${detail ? `  (${detail})` : ""}`);
}

// The app relaunched: every tab resumes its session in the background. Drawing
// the old conversation back is not a turn, and the name must hold.
for (const tab of tabs) await rpc("pty_kill", { id: tab.session.id }).catch(() => {});
await sleep(1500);
const before = new Map(tabs.map((tab) => [tab, { status: tab.status, name: tab.session.name }]));
for (const tab of tabs) await launch(tab, true);
await sleep(15_000);
for (const tab of tabs) {
  const was = before.get(tab);
  check(tab.provider, "a resumed tab out of sight keeps its indicator", tab.statuses.length === 0, `${was.status} → ${tab.statuses.map((s) => s.status).join(" → ")}`);
  await sweep(tab);
  check(tab.provider, "a resumed tab keeps its name", tab.session.name === was.name, tab.session.name);
  check(tab.provider, "a resumed tab shows the old conversation", tab.screen.includes(ANSWER), strip(tab.screen).replace(/\s+/g, " ").slice(-200));
}

console.log("");
failed = 0;
for (const { provider, name, ok, detail } of results.slice(printed)) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${provider.padEnd(8)} ${name}${detail ? `  (${detail})` : ""}`);
}
failed = results.filter((r) => !r.ok).length;

for (const tab of tabs) await rpc("pty_kill", { id: tab.session.id }).catch(() => {});
ws.close();
daemon.kill();
process.exit(failed ? 1 : 0);
