// The heavy user's window the stress specs run in: see `seedHeavy`.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { launchCrew, type Crew } from "../harness.ts";
import type { Session, Workspace } from "../../src/lib/types.ts";

const run = promisify(execFile);
const NAMES = ["crew", "cuddles", "knowhub", "furryapp", "furry-web", "nerblabs", "atlas", "zeta"];
/** Sessions of the user's own per workspace, then bots, then how many tabs are open. */
const SHAPE_AT_1 = [
  { sessions: 400, bots: 3, tabs: 10 },
  { sessions: 120, bots: 2, tabs: 6 },
  { sessions: 60, bots: 2, tabs: 5 },
  { sessions: 50, bots: 2, tabs: 4 },
  { sessions: 30, bots: 1, tabs: 3 },
  { sessions: 30, bots: 1, tabs: 3 },
  { sessions: 15, bots: 1, tabs: 2 },
  { sessions: 10, bots: 1, tabs: 2 },
];

export type Seeded = { workspace: Workspace; sessions: Session[]; tabs: Session[]; marker: (s: Session) => string };

/** The text of a session's last block, in a `code` element once its chat shows it. */
export const markerOf = (session: Session) => `end-${session.id.slice(0, 8)}`;

// ---------- the data ----------

const q = (text: string) => `'${text.replaceAll("'", "''")}'`;

function turnBlocks(session: Session, turn: number) {
  const file = `src/module-${turn % 17}.ts`;
  const code = turn % 2 === 0;
  return [
    { role: "user", text: `Turn ${turn}: look at ${file} and fix the flaky check in ${session.name}. Keep the API as it is.` },
    { role: "reasoning", text: "Read the module first, then the test that flakes, then decide whether it is the clock or the order of the writes." },
    { role: "tool", text: "", extra: { tool: { callId: `${session.id}-r${turn}`, name: "Read", title: `Read ${file}`, status: "completed", detail: { kind: "file", path: file } } } },
    { role: "tool", text: "", extra: { tool: { callId: `${session.id}-g${turn}`, name: "Grep", title: "Search setTimeout", status: "completed", detail: { kind: "search", query: "setTimeout", matches: 7 + turn } } } },
    {
      role: "tool",
      text: "",
      extra: {
        tool: {
          callId: `${session.id}-b${turn}`,
          name: "Bash",
          title: "Run the tests",
          status: "completed",
          detail: { kind: "command", command: "npx vitest run", exitCode: 0, output: Array.from({ length: 10 }, (_, i) => ` ✓ src/module-${i}.test.ts (${i + 3} tests) ${i * 7}ms`).join("\n") },
        },
      },
    },
    {
      role: "assistant",
      text: [
        `## What changed in \`${file}\``,
        "",
        "The check read the clock twice, so a slow machine saw two different minutes:",
        "",
        "- read `Date.now()` **once** per call",
        "- pass it down instead of reading it again",
        "- the test pins the clock with `vi.setSystemTime`",
        "",
        ...(code ? ["```ts", "export function due(at: number, now = Date.now()): boolean {", "  return at <= now;", "}", "```", ""] : []),
        "All green locally, 212 tests.",
      ].join("\n"),
      extra: { usage: { durationMs: 41_000, inputTokens: 18_400, outputTokens: 900, costUsd: 0.07 } },
    },
  ];
}

/** Writes `count` blocks of history for each session, the last one carrying its marker. */
function historySql(session: Session, count: number, now: number, out: string[]) {
  const blocks: { role: string; text: string; extra?: object }[] = [];
  for (let turn = 1; blocks.length < count - 1; turn++) blocks.push(...turnBlocks(session, turn));
  blocks.length = count - 1;
  blocks.push({ role: "assistant", text: `Done. Marker \`${markerOf(session)}\` for the stress run.` });
  blocks.forEach((block, index) => {
    const pos = index + 1;
    out.push(
      `INSERT INTO messages (session_id, pos, id, role, text, at, extra_json) VALUES (${q(session.id)}, ${pos}, ${q(`st-${session.id}-${pos}`)}, ${q(block.role)}, ${q(block.text)}, ${now - (count - pos) * 60_000}, ${q(JSON.stringify(block.extra ?? {}))});`,
    );
  });
}

export type HeavyOptions = {
  /** Multiplies every workspace's sessions. */
  scale?: number;
  /** What the first workspace's repo holds, besides its README. */
  files?: Record<string, string>;
};

/**
 * Eight workspaces shaped like a real data set (one with hundreds of
 * sessions, the rest tapering off), bots, subagents, transcripts written
 * straight to the database, and a strip of open tabs in each. The window
 * opens on the first workspace, its first tab a very long chat.
 */
export async function seedHeavy({ scale = 1, files }: HeavyOptions = {}): Promise<{ crew: Crew; seeded: Seeded[] }> {
  const SHAPE = SHAPE_AT_1.map((s) => ({ ...s, sessions: Math.round(s.sessions * scale) }));
  const [first, ...rest] = NAMES.slice(0, SHAPE.length);
  let crew = await launchCrew({
    repos: [files ? { name: first!, files: { "README.md": `# ${first}\n`, ...files } } : first!, ...rest],
  });
  const made: { workspace: Workspace; sessions: Session[]; bots: Session[] }[] = [];
  for (const [index, workspace] of crew.workspaces.entries()) {
    const shape = SHAPE[index]!;
    const create = (kind: "terminal" | "bot", name: string) =>
      crew.request<Session>("session_create", {
        workspaceId: workspace.id,
        kind,
        name,
        provider: "claude",
        model: "",
        description: kind === "bot" ? `Keeps ${workspace.name} tidy.` : "",
        autonomy: "ask",
        worktree: null,
      });
    const bots: Session[] = [];
    for (let b = 0; b < shape.bots; b++) bots.push(await create("bot", `${workspace.name} bot ${b + 1}`));
    const sessions: Session[] = [];
    for (let start = 0; start < shape.sessions; start += 25) {
      const batch = Array.from({ length: Math.min(25, shape.sessions - start) }, (_, i) =>
        create("terminal", `${workspace.name} task ${start + i + 1}`),
      );
      sessions.push(...(await Promise.all(batch)));
    }
    made.push({ workspace, sessions, bots });
  }

  const now = Date.now();
  const sql: string[] = ["PRAGMA trusted_schema = ON;", "BEGIN;"];
  const plan: Seeded[] = [];
  for (const [index, { workspace, sessions, bots }] of made.entries()) {
    const shape = SHAPE[index]!;
    // The tabs: the first bot and the newest sessions; the first tab holds a long history.
    const tabs = [bots[0]!, ...sessions.slice(0, shape.tabs - 1)];
    const tabIds = new Set(tabs.map((s) => s.id));
    const lead = sessions[0]!;
    sessions.forEach((session, i) => {
      // One in ten is a subagent of the lead; one in twenty finished unread.
      if (i % 10 === 9 && !tabIds.has(session.id)) {
        sql.push(`UPDATE sessions SET kind = 'child', parent_id = ${q(lead.id)} WHERE id = ${q(session.id)};`);
      } else if (i % 20 === 7) sql.push(`UPDATE sessions SET status = 'done' WHERE id = ${q(session.id)};`);
    });
    for (const [i, session] of [...bots, ...sessions].entries()) {
      // Most chats are short; every tenth is long, and the tabs' first one is very long.
      const count = session.id === tabs[0]!.id || session.id === lead.id ? 1500 : i % 10 === 0 ? 300 : 60;
      historySql(session, count, now, sql);
      sql.push(
        `UPDATE sessions SET provider_session_id = ${q(`00000000-0000-4000-8000-${session.id.slice(-12)}`)}, cursor = ${count}, updated_at = ${now - i * 90_000} WHERE id = ${q(session.id)};`,
      );
    }
    const strip = {
      tabs: tabs.map((s) => ({ id: `session:${s.id}`, kind: "session", sessionId: s.id })),
      activeId: `session:${tabs[0]!.id}`,
    };
    sql.push(`INSERT OR REPLACE INTO app_state (key, value) VALUES (${q(`tabs:${workspace.id}`)}, ${q(JSON.stringify(strip))});`);
    plan.push({ workspace, sessions: [...bots, ...sessions], tabs, marker: markerOf });
  }
  sql.push("COMMIT;");

  const file = path.join(crew.root, "stress.sql");
  await writeFile(file, sql.join("\n"));
  crew = await crew.restart(async () => {
    await run("sh", ["-c", `sqlite3 -bail "${path.join(crew.userData, "crew.sqlite3")}" < "${file}"`], { maxBuffer: 1 << 26 });
  });
  const seeded = plan.map((p) => ({ ...p, workspace: crew.workspaces.find((w) => w.id === p.workspace.id) ?? p.workspace }));
  return { crew, seeded };
}
