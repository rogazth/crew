// Builds a database in the shape crewd left behind before the messages table
// existed, opens it with the current daemon, and checks the conversation is
// still there afterwards. The blob column is dropped by migration 13, so this
// is the one path where a mistake loses history rather than breaking a build.
//
//   cargo build -p crewd && node scripts/migrate-check.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  db.close();
  return blocks;
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

const checks = [];
checks.push(["the daemon opened the old database", page.ok, page.error ?? ""]);
const texts = (page.result?.blocks ?? []).map((block) => block.text);
checks.push([
  "every block that was in the column is still there",
  seeded.every((block) => texts.includes(block.text)),
  `${texts.length} blocks back`,
]);
checks.push(["they came back in order", texts.join("|") === seeded.map((b) => b.text).join("|"), texts[0] ?? ""]);

ws.close();
daemon.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 300));

const db = new DatabaseSync(dbPath);
const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
checks.push(["the blob column is gone", !columns.includes("blocks_json"), columns.join(",")]);
const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
checks.push(["the schema is at 13", version === 13, String(version)]);
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
