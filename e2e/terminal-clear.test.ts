// S1–S4: `/clear` in a claude terminal. The conversation it leaves, if
// anything was said in it, stays as a session of its own (same worktree,
// provider and name, the face the terminal showed) that resumes that
// conversation when opened; the terminal goes on in the new one, in the same
// tab, with the same CLI. crewd's rows, the fake claude's launch log and the
// transcripts it wrote are the witnesses.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  claudeStarts,
  holdsFor,
  launchCrew,
  MOD,
  newTerminal,
  pressChord,
  sessionRow,
  sessionTab,
  sessions,
  storedStatus,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

const get = (crew: Crew, id: string) => crew.request<Session | null>("session_get", { id });

/** A turn typed into the terminal on screen, run to its end (the tab is watched, so it rests as idle). */
async function turn(crew: Crew, session: Session, line: string): Promise<void> {
  await typeInTerminal(crew, line);
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: `${line}: the turn starts` });
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: `${line}: the turn ends` });
}

/** The sessions crewd has bound to Claude conversation `id`. */
async function holding(crew: Crew, workspaceId: string, id: string): Promise<Session[]> {
  return (await sessions(crew, workspaceId)).filter((row) => row.providerSessionId === id);
}

/** The conversations the fake claude wrote a transcript for under `cwd`. */
async function transcripts(crew: Crew, cwd: string): Promise<string[]> {
  const dir = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const files = await readdir(dir).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith(".jsonl")).map((file) => file.slice(0, -".jsonl".length));
}

type Faces = Record<string, { style?: string; seed?: string }>;

async function faces(crew: Crew): Promise<Faces> {
  const raw = await crew.request<string | null>("state_get", { key: "agent:faces" });
  return raw ? (JSON.parse(raw) as Faces) : {};
}

test("S1: /clear after a turn keeps the old conversation as its own session, in the same tab and CLI", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const live = await newTerminal(crew, workspace.id);
  const tabId = await sessionTab(crew, live).getAttribute("data-tab-id");
  // Conversation A: Claude names it, and the terminal takes the name.
  await turn(crew, live, "title Login work");
  await waitFor(async () => (await get(crew, live.id))?.name === "Login work", { message: "the terminal takes Claude's title" });
  const launches = (await crew.claudeLaunches()).length;

  await typeInTerminal(crew, "/clear");
  await turn(crew, live, "hello");

  const split = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row) => row.id !== live.id),
    { timeout: 10_000, message: "the conversation before /clear becomes a session" },
  );
  assert.equal(split.providerSessionId, live.id, "it holds conversation A");
  assert.deepEqual(
    [split.name, split.kind, split.provider, split.worktree],
    ["Login work", "terminal", live.provider, live.worktree],
    "it is named as the terminal was, where the terminal was",
  );
  const now = await get(crew, live.id);
  assert.ok(now);
  const b = now.providerSessionId;
  assert.ok(b && b !== live.id, `the terminal moves to the new conversation (bound: ${b})`);
  assert.ok((await transcripts(crew, workspace.path)).includes(b), "the terminal is bound to the conversation the CLI wrote after /clear");
  assert.notEqual(now.name, "Login work", "the terminal is named afresh");
  // Terminals draw no face; the one it would have drawn, from its id, is written down for the split.
  assert.deepEqual((await faces(crew))[split.id], { seed: live.id });

  // Both in the sidebar; the tab and its CLI are the same as before.
  await sessionRow(crew, "Login work").waitFor();
  await sessionRow(crew, now.name).waitFor();
  assert.equal(await sessionTab(crew, live).getAttribute("data-tab-id"), tabId);
  await holdsFor(1500, async () => (await crew.claudeLaunches()).length === launches, "a CLI was launched");
  assert.equal(await sessionTab(crew, split).count(), 0, "a tab opened for the split session");

  // Opening it resumes conversation A in a tab of its own.
  await sessionRow(crew, "Login work").click({ force: true });
  const resumed = await waitFor(
    // Its hooks name it; the conversation it resumes is A's.
    async () => (await crew.claudeLaunches()).slice(launches).find((run) => run.argv.some((arg) => arg.includes(split.id))),
    { timeout: 15_000, message: "the split session's CLI starts" },
  );
  assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], live.id, `argv: ${resumed.argv.join(" ")}`);
  await sessionTab(crew, split).waitFor();
  assert.equal(await sessionTab(crew, live).getAttribute("data-tab-id"), tabId);

  crew = await crew.restart();
  assert.equal((await get(crew, split.id))?.providerSessionId, live.id, "the split session survives the restart");
  assert.equal((await get(crew, live.id))?.providerSessionId, b, "the terminal survives the restart");
});

test("S2: turn, /clear, turn, /clear and ⌘W at once: both conversations stay, the empty terminal goes", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const live = await newTerminal(crew, workspace.id);
  await turn(crew, live, "hello");
  await typeInTerminal(crew, "/clear");
  await turn(crew, live, "hello");
  const b = await waitFor(
    async () => (await transcripts(crew, workspace.path)).find((id) => id !== live.id),
    { message: "the turn after /clear lands in a transcript of its own" },
  );
  await typeInTerminal(crew, "/clear");
  // Only as long as the hook takes to write the third start down.
  await waitFor(
    async () => (await claudeStarts(crew, live.id)).some((start) => start.session_id !== live.id && start.session_id !== b),
    { message: "the second /clear reaches the bind folder" },
  );
  const learned = (await get(crew, live.id))?.providerSessionId;
  t.diagnostic(`crewd had bound ${learned === b ? "B" : learned ? "C" : "nothing"} when the tab closed`);
  await pressChord(crew, `${MOD}+w`);
  await sessionTab(crew, live).waitFor({ state: "detached" });

  await waitFor(async () => (await get(crew, live.id)) === null, { timeout: 5000, message: "crewd deletes the empty terminal" });
  for (const [label, id] of [["A", live.id], ["B", b]] as const) {
    const held = await holding(crew, workspace.id, id);
    assert.equal(held.length, 1, `conversation ${label} is held by ${held.length} sessions`);
    assert.equal(held[0]?.kind, "terminal");
  }
  assert.equal((await sessions(crew, workspace.id)).length, 2);
});

test("S3: /clear before anything was said makes no session", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const live = await newTerminal(crew, workspace.id);
  await typeInTerminal(crew, "/clear");
  const moved = await waitFor(
    async () => {
      const bound = (await get(crew, live.id))?.providerSessionId;
      return bound && bound !== live.id && bound;
    },
    { message: "crewd binds the terminal to Claude's new id" },
  );
  await holdsFor(
    2000,
    async () => {
      const rows = await sessions(crew, workspace.id);
      return (rows.length === 1 && rows[0]?.name === live.name) || `sessions: ${rows.map((row) => row.name).join(", ")}`;
    },
    "an empty conversation became a session",
  );
  assert.equal((await get(crew, live.id))?.providerSessionId, moved);
});

test("S4: the session split off keeps the face the terminal wore", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const live = await newTerminal(crew, workspace.id);
  const face = { style: "moods", seed: "picked by hand" };
  await crew.request("state_set", { key: "agent:faces", value: JSON.stringify({ [live.id]: face }) });
  await turn(crew, live, "hello");
  await typeInTerminal(crew, "/clear");

  const split = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row) => row.id !== live.id),
    { timeout: 10_000, message: "the conversation before /clear becomes a session" },
  );
  const stored = await faces(crew);
  assert.deepEqual(stored[split.id], face, "the split session wears the terminal's face");
  assert.deepEqual(stored[live.id], face, "the terminal keeps its face");
});
