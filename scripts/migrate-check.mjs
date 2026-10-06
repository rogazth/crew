// Builds a database in the shape crewd left behind before the messages table
// existed, opens it with the current daemon, and checks the conversation is
// still there afterwards. The blob column is dropped by migration 13, so this
// is the one path where a mistake loses history rather than breaking a build.
// Migration 23 splits agents from sessions: the agent, the terminal and the
// routine seeded here must come out the other side as they went in. Migration
// 25 renames agents to bots: the identity, its kind and the window's keys
// in app_state come out under the new word. Migration 26 gives letters a kind
// and a lifecycle: a delivered one stays delivered, a waiting one pending.
// Migration 27 moves Cursor children to ACP: the `-p` chat a child was bound
// to is dropped (and marked for the note its next turn shows), its
// conversation in Crew stays, and a Cursor terminal keeps its chat.
// Migration 28 indexes the mailbox by sender and by reader for the pair
// threads: the old letters come back as one thread, both ways, in order.
//
//   cargo build -p crewd && node scripts/migrate-check.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const REPO = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "crew-migrate-"));
const dbPath = join(dir, "crew.sqlite3");

/** The schema as of migration 9, written by hand from store.rs. */
function seedOldDatabase() {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      created_at INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX workspaces_path_idx ON workspaces (path);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '', provider_session_id TEXT,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '', notifications INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle',
      autonomy TEXT NOT NULL DEFAULT 'ask'
    );
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      prompt TEXT NOT NULL, schedule TEXT NOT NULL, last_run_at INTEGER,
      next_run_at INTEGER, runs_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT
    );
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
  `);
  for (let version = 1; version <= 9; version += 1) {
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
  }
  db.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "w1",
    "old",
    dir,
    Date.now(),
  );
  const blocks = [
    { id: "b1", role: "user", text: "what did we decide about the sidebar?", at: Date.now() - 60_000 },
    { id: "b2", role: "assistant", text: "grouping is memoised in groupSessions", at: Date.now() - 50_000 },
    { id: "b3", role: "user", text: "good, leave it", at: Date.now() - 40_000 },
  ];
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, kind, name, provider, model, blocks_json, created_at, updated_at)
     VALUES (?, ?, 'agent', 'Planner', 'claude', 'claude-opus-5', ?, ?, ?)`,
  ).run("s1", "w1", JSON.stringify(blocks), Date.now(), Date.now());
  // An agent with a job, a terminal next to it (named, or the startup sweep
  // takes it for an empty one), a routine on the agent, and the window's keys
  // as an old build left them.
  db.prepare("UPDATE sessions SET description = ?, autonomy = 'full' WHERE id = 's1'").run("You keep the roadmap.");
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, kind, name, provider, model, created_at, updated_at)
     VALUES ('t1', 'w1', 'terminal', 'Refactor', 'claude', '', ?, ?)`,
  ).run(Date.now(), Date.now());
  db.prepare(
    `INSERT INTO routines (id, session_id, name, prompt, schedule, created_at, updated_at)
     VALUES ('r1', 's1', 'standup', 'Sum up yesterday', '{"kind":"daily","hour":9,"minute":0}', ?, ?)`,
  ).run(Date.now(), Date.now());
  // A Cursor child bound to a `-p` chat, with what it said, and a Cursor
  // terminal bound to its own.
  const cursorBlocks = [
    { id: "c1b1", role: "user", text: "fix the flaky login test", at: Date.now() - 30_000 },
    { id: "c1b2", role: "assistant", text: "the retry was racing the cookie write", at: Date.now() - 20_000 },
  ];
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, kind, name, provider, model, provider_session_id, blocks_json, created_at, updated_at)
     VALUES ('c1', 'w1', 'child', 'cursor: fix', 'cursor', 'auto', 'chat-p1', ?, ?, ?)`,
  ).run(JSON.stringify(cursorBlocks), Date.now(), Date.now());
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, kind, name, provider, model, provider_session_id, created_at, updated_at)
     VALUES ('c2', 'w1', 'terminal', 'Cursor shell', 'cursor', 'auto', 'chat-t1', ?, ?)`,
  ).run(Date.now(), Date.now());
  const state = db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)");
  state.run("agent:faces", JSON.stringify({ s1: { seed: "s1" } }));
  state.run("agent:avatar", "robot");
  state.run("sidebar:prefs", JSON.stringify({ hiddenKinds: ["agent"], hiddenProviders: ["codex"] }));
  db.close();
  return blocks;
}

/** The newest migration store.rs knows: what the daemon must leave the database at. */
function latestVersion() {
  const source = readFileSync(join(REPO, "crates/crew-core/src/store.rs"), "utf8");
  return Math.max(...[...source.matchAll(/if current < (\d+)/g)].map((match) => Number(match[1])));
}

/**
 * The shape after migration 12: the rows exist, but this one's sync fell behind
 * and the table is missing the last block. Migration 13 has to notice before it
 * drops the column, or that block is gone.
 */
function leaveRowsBehind(blocks) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      pos INTEGER NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      at INTEGER NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (session_id, pos)
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TABLE send_nonces (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, nonce)
    );
    CREATE TABLE mailbox (
      id TEXT PRIMARY KEY,
      to_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      from_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      from_name TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, delivered_at INTEGER
    );
  `);
  // Everything but the last block, which is what a failed flush leaves.
  const insert = db.prepare(
    "INSERT INTO messages (session_id, pos, id, role, text, at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  blocks.slice(0, -1).forEach((block, index) => {
    insert.run("s1", index + 1, block.id, block.role, block.text, block.at);
  });
  // One letter already handed over, one still waiting (for the terminal, so
  // the startup sweep does not start a turn on it).
  const letter = db.prepare(
    "INSERT INTO mailbox (id, to_session, from_session, from_name, text, at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  letter.run("l1", "s1", "t1", "Refactor", "tests pass", Date.now() - 30_000, Date.now() - 20_000);
  letter.run("l2", "t1", "s1", "Planner", "rebase on master", Date.now() - 10_000, null);
  for (const version of [10, 11, 12]) {
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
  }
  db.close();
}

const seeded = seedOldDatabase();
if (process.env.CASE === "behind") leaveRowsBehind(seeded);

const daemon = spawn(join(REPO, "target/debug/crewd"), [`--data-dir=${dir}`], {
  stdio: ["pipe", "pipe", "pipe"],
});
daemon.stderr.on("data", (chunk) => process.stderr.write(`[crewd] ${chunk}`));
const info = await new Promise((resolve, reject) => {
  let buffer = "";
  daemon.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
  });
  daemon.on("exit", (code) => reject(new Error(`crewd exited ${code} — the migration failed`)));
});

const ws = new WebSocket(info.url);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.send(JSON.stringify({ auth: info.token }));
const answer = new Promise((resolve) => {
  ws.addEventListener("message", (message) => {
    const parsed = JSON.parse(message.data);
    if (parsed.id === 1) resolve(parsed);
  });
});
ws.send(JSON.stringify({ id: 1, method: "transcript_tail", params: { sessionId: "s1", limit: 100 } }));
const page = await answer;

const call = (id, method, params) =>
  new Promise((resolve) => {
    const listen = (message) => {
      const parsed = JSON.parse(message.data);
      if (parsed.id === id) {
        ws.removeEventListener("message", listen);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", listen);
    ws.send(JSON.stringify({ id, method, params }));
  });
const listed = (await call(2, "session_list", { workspaceId: "w1" })).result ?? [];
const cursorPage = await call(4, "transcript_tail", { sessionId: "c1", limit: 100 });
const routines = (await call(3, "routine_list_for_session", { sessionId: "s1" })).result ?? [];
const pairs = (await call(5, "thread_pairs", { sessionId: "s1" })).result ?? [];
const thread = (await call(6, "thread_messages", { a: "s1", b: "t1" })).result ?? { letters: [] };

const checks = [];
checks.push(["the daemon opened the old database", page.ok, page.error ?? ""]);
const texts = (page.result?.blocks ?? []).map((block) => block.text);
checks.push([
  "every block that was in the column is still there",
  seeded.every((block) => texts.includes(block.text)),
  `${texts.length} blocks back`,
]);
checks.push(["they came back in order", texts.join("|") === seeded.map((b) => b.text).join("|"), texts[0] ?? ""]);
const planner = listed.find((row) => row.id === "s1");
const shell = listed.find((row) => row.id === "t1");
checks.push([
  "the agent is a bot now, with its identity",
  planner?.kind === "bot" && planner?.botId === "s1" && planner?.name === "Planner" &&
    planner?.description === "You keep the roadmap." && planner?.autonomy === "full",
  JSON.stringify(planner ?? null),
]);
checks.push(["the terminal is a session with no bot", shell?.kind === "terminal" && !shell?.botId, JSON.stringify(shell ?? null)]);
const cursorTexts = (cursorPage.result?.blocks ?? []).map((block) => block.text);
checks.push([
  "the Cursor child's conversation is still in Crew",
  cursorTexts.includes("fix the flaky login test") && cursorTexts.includes("the retry was racing the cookie write"),
  cursorTexts.join("|"),
]);
checks.push(["the bot's routine is still its own", routines.length === 1 && routines[0]?.name === "standup", `${routines.length} routines`]);

ws.close();
daemon.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 300));

const db = new DatabaseSync(dbPath);
const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
checks.push(["the blob column is gone", !columns.includes("blocks_json"), columns.join(",")]);
const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
const latest = latestVersion();
checks.push([`the schema is at ${latest}`, version === latest, String(version)]);
const bots = db.prepare("SELECT id, name, description, autonomy FROM bots").all();
checks.push([
  "bots holds the identity, sessions the CLIs",
  bots.length === 1 && bots[0].id === "s1" && bots[0].name === "Planner" &&
    db.prepare("SELECT bot_id FROM sessions WHERE id = 't1'").get().bot_id === null,
  JSON.stringify(bots),
]);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE name IN ('agents', 'agents_workspace_idx') OR name LIKE 'bots%'")
  .all()
  .map((row) => row.name)
  .sort();
const references = db.prepare("SELECT DISTINCT \"table\" AS t FROM pragma_foreign_key_list('sessions')").all().map((row) => row.t);
checks.push([
  "nothing is called agents any more, and the foreign keys followed",
  tables.join(",") === "bots,bots_workspace_idx" && !columns.includes("agent_id") && !references.includes("agents"),
  `${tables.join(",")} · ${references.join(",")}`,
]);
const state = Object.fromEntries(db.prepare("SELECT key, value FROM app_state").all().map((row) => [row.key, row.value]));
checks.push([
  "the window's keys moved to bot:",
  state["bot:faces"] === JSON.stringify({ s1: { seed: "s1" } }) && state["bot:avatar"] === "robot" &&
    !("agent:faces" in state) && !("agent:avatar" in state) &&
    JSON.stringify(JSON.parse(state["sidebar:prefs"] ?? "{}").hiddenKinds) === JSON.stringify(["bot"]),
  JSON.stringify(state),
]);
const mailboxColumns = db.prepare("PRAGMA table_info(mailbox)").all().map((row) => row.name);
checks.push([
  "letters have a kind and a lifecycle, sessions the hand-off columns",
  ["kind", "event_cursor", "claimed_at", "disposed_at"].every((name) => mailboxColumns.includes(name)) &&
    ["handed_off_by", "user_seen"].every((name) => columns.includes(name)),
  `${mailboxColumns.join(",")} · ${columns.join(",")}`,
]);
const cursorRows = Object.fromEntries(
  db.prepare("SELECT id, provider_session_id FROM sessions WHERE provider = 'cursor'").all().map((row) => [row.id, row.provider_session_id]),
);
checks.push([
  "the Cursor child lost its -p chat and is marked for the note; the terminal kept its own",
  cursorRows.c1 === null && state["cursor:acp-note:c1"] === "chat-p1" && cursorRows.c2 === "chat-t1" && !("cursor:acp-note:c2" in state),
  JSON.stringify(cursorRows),
]);
const mailboxIndexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'mailbox_%' ORDER BY name")
  .all()
  .map((row) => row.name);
checks.push([
  "the mailbox is indexed by sender and by reader for the threads",
  ["mailbox_from_idx", "mailbox_pending_idx", "mailbox_to_idx"].every((name) => mailboxIndexes.includes(name)),
  mailboxIndexes.join(","),
]);
if (process.env.CASE === "behind") {
  const shape = thread.letters.map((letter) => `${letter.id}:${letter.from.id}>${letter.to.id}:${letter.state}`).join(" ");
  checks.push([
    "the old letters are one thread, both ways, oldest first",
    shape === "l1:t1>s1:delivered l2:s1>t1:pending" &&
      pairs.length === 1 && pairs[0].peer.id === "t1" && pairs[0].peer.name === "Refactor" && pairs[0].count === 2,
    `${shape} · ${JSON.stringify(pairs)}`,
  ]);
  const letters = Object.fromEntries(
    db
      .prepare("SELECT id, kind, claimed_at, delivered_at, disposed_at FROM mailbox ORDER BY id")
      .all()
      .map((row) => [row.id, row]),
  );
  const { l1, l2 } = letters;
  checks.push([
    "a delivered letter stays delivered, a waiting one pending",
    l1?.kind === "message" && l1.delivered_at !== null && l1.claimed_at === l1.delivered_at && l1.disposed_at === null &&
      l2?.kind === "message" && l2.claimed_at === null && l2.delivered_at === null && l2.disposed_at === null,
    JSON.stringify(letters),
  ]);
}
const searchable = db
  .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'sidebar'")
  .get().n;
checks.push(["the old conversation is searchable", searchable > 0, `${searchable} hits`]);
db.close();

let failed = 0;
for (const [what, ok, note] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${note ? ` (${note})` : ""}`);
}
process.exit(failed === 0 ? 0 : 1);
