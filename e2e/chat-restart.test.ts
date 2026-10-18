// A chat session mid-turn when its CLI goes away under it: the app quits and
// opens again, this Mac's crewd is killed and the app brings it back, or the
// crewd of the machine the session runs on restarts. The CLI dies with its
// crewd, and the message its turn was carrying is handed over again once
// crewd is back: a new CLI resumes the same conversation (`--resume <id>`, in
// the fake claude's own log), hears the message a second time, and runs the
// turn to its end. What was unread stays unread, names stay, and the CLI from
// before is gone rather than running on unseen.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session, Workspace } from "../src/lib/types.ts";
import {
  addRemote,
  crewdPid,
  holdsFor,
  launchCrew,
  lightIn,
  MOD,
  newSession,
  pressChord,
  remoteRequest,
  sendInChat,
  sessionRow,
  sessionTab,
  storedStatus,
  waitFor,
  type ClaudeLaunch,
  type Crew,
  type RemoteDaemon,
} from "./harness.ts";

/** The row's light and crewd's status, as one reading. */
async function state(crew: Crew, session: Session): Promise<{ light: string; stored: Session["status"] | null }> {
  const [light, stored] = await Promise.all([lightIn(sessionRow(crew, session.name)), storedStatus(crew, session.id)]);
  return { light, stored };
}

async function reaches(crew: Crew, session: Session, light: string, stored: Session["status"], timeout = 10_000) {
  let last = {};
  const ok = await waitFor(
    async () => {
      const now = await state(crew, session);
      last = now;
      return now.light === light && now.stored === stored;
    },
    { timeout },
  ).catch(() => false);
  assert.ok(ok, `${session.name} should read ${light} (crewd: ${stored}); got ${JSON.stringify(last)}`);
}

const notWorking = (now: { light: string; stored: Session["status"] | null }) => now.light !== "Working" && now.stored !== "working";

/** The launch of `session`'s CLI after the first `skip` launches, once there is one. */
function relaunch(crew: Crew, session: Session, skip: number, timeout = 15_000): Promise<ClaudeLaunch> {
  return waitFor(
    async () =>
      (await crew.claudeLaunches())
        .slice(skip)
        // Crew's own launch that asks a CLI to name a session reads none of the user's servers; it is not the session's.
        .find((run) => run.argv.includes(session.id) && !run.argv.includes("--strict-mcp-config")),
    { timeout, message: `${session.name}'s CLI starts again` },
  );
}

const argAfter = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

/** What the user said in `session`'s conversation, from the transcript the fake claude keeps under `cwd`. */
async function heard(crew: Crew, cwd: string, session: Session): Promise<string[]> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.id}.jsonl`);
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { content?: unknown } })
    .flatMap((record) => (record.type === "user" && typeof record.message?.content === "string" ? [record.message.content] : []));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A line of the chat on screen, by the whole of its text. */
function said(crew: Crew, text: string) {
  return crew.window.locator("p:visible").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
}

test("quitting mid-turn: the relaunch resumes the CLI on the message it was carrying and runs that turn to its end, and Unread survives", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const a = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  // b finishes a turn out of sight: Unread.
  const b = await newSession(crew, workspace.id);
  await sendInChat(crew, "work 2");
  await waitFor(async () => (await storedStatus(crew, b.id)) === "working", { message: "b's turn starts" });
  await sessionTab(crew, a).click();
  await reaches(crew, b, "Unread", "done");

  // a is mid-turn, on screen, when the app quits.
  await sendInChat(crew, "work 6");
  await reaches(crew, a, "Working", "working", 5000);
  await waitFor(async () => (await heard(crew, workspace.path, a)).includes("work 6"), { message: "a's CLI took the message in" });
  const [cli] = (await crew.claudeLaunches()).filter((run) => run.argv.includes(a.id));
  assert.ok(cli);
  const before = (await crew.claudeLaunches()).length;
  crew = await crew.restart();
  assert.ok(!alive(cli.pid), "the CLI outlived the app");

  // With nobody typing, a's CLI comes back on its conversation and hears the message again.
  const again = await relaunch(crew, a, before);
  assert.equal(argAfter(again.argv, "--resume"), a.id, `a resumes its conversation: ${JSON.stringify(again.argv)}`);
  assert.equal(argAfter(again.argv, "--session-id"), undefined);
  await waitFor(async () => (await heard(crew, workspace.path, a)).filter((text) => text === "work 6").length === 2, {
    message: "the resumed CLI is handed the message the quit cut off",
  });
  await said(crew, "Reply 1: work 6").waitFor({ timeout: 15_000 });
  await reaches(crew, a, "Idle", "idle");
  assert.deepEqual(await state(crew, b), { light: "Unread", stored: "done" }, "b stopped reading Unread after the relaunch");

  // The conversation goes on on that CLI.
  await sendInChat(crew, "still there?");
  await said(crew, "Reply 2: still there?").waitFor();
  const since = (await crew.claudeLaunches()).slice(before);
  assert.equal(since.filter((run) => run.argv.includes(a.id) && !run.argv.includes("--strict-mcp-config")).length, 1);
});

test("crewd killed mid-turn: the app brings it back, every session keeps its name, the old CLI is gone, and a new one runs the turn", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;

  const s1 = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  const s2 = await newSession(crew, workspace.id);
  await sendInChat(crew, "hello");
  await said(crew, "Reply 1: hello").waitFor();
  await waitFor(async () => (await storedStatus(crew, s2.id)) === "idle", { message: "s2's turn ends" });
  await crew.request("session_rename", { id: s2.id, name: `Reconcile ${Date.now().toString(36)}` });
  const stored = (await crew.request<Session[]>("session_list", { workspaceId: workspace.id }))
    .map((session) => ({ id: session.id, name: session.name }))
    .sort((x, y) => x.id.localeCompare(y.id));

  await sessionTab(crew, s1).click();
  await sendInChat(crew, "work 6");
  await reaches(crew, s1, "Working", "working", 5000);
  await waitFor(async () => (await heard(crew, workspace.path, s1)).includes("work 6"), { message: "s1's CLI took the message in" });
  const cli = (await crew.claudeLaunches()).find((run) => run.argv.includes(s1.id));
  assert.ok(cli);
  const before = (await crew.claudeLaunches()).length;
  await page.evaluate(() => Object.assign(window, { beforeCrash: true }));
  const pid = await crewdPid(crew);
  process.kill(pid, "SIGKILL");

  // The app starts a new crewd and reloads the window; the harness follows it.
  const next = await waitFor(async () => (await crewdPid(crew).catch(() => pid)) !== pid && crewdPid(crew), {
    timeout: 15_000,
    message: "the app starts crewd again",
  });
  t.diagnostic(`crewd ${pid} → ${next}`);
  await waitFor(() => page.evaluate(() => !("beforeCrash" in window)), { timeout: 15_000, message: "the window reloads" });

  const after = (await crew.request<Session[]>("session_list", { workspaceId: workspace.id }))
    .map((session) => ({ id: session.id, name: session.name }))
    .sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(after, stored, "a session or its name was lost");

  // The CLI that ran the turn went down with crewd, rather than running on unseen beside a new one.
  await waitFor(() => !alive(cli.pid), { timeout: 5000, message: `the CLI crewd ran before the crash (pid ${cli.pid}) goes` });

  // A new CLI resumes the conversation, is handed the message again, and the turn ends.
  const again = await relaunch(crew, s1, before);
  assert.equal(argAfter(again.argv, "--resume"), s1.id, JSON.stringify(again.argv));
  await waitFor(async () => (await heard(crew, workspace.path, s1)).filter((text) => text === "work 6").length === 2, {
    message: "the resumed CLI is handed the message the crash cut off",
  });
  await said(crew, "Reply 1: work 6").waitFor({ timeout: 15_000 });
  await reaches(crew, s1, "Idle", "idle");
  await holdsFor(2000, async () => notWorking(await state(crew, s1)) || "Working again", `${s1.name} went back to Working`);
});

test("a session whose machine's crewd restarted mid-turn resumes its CLI there, runs the turn to its end, and takes the next message", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    const window = crew.window;
    const workspace = await remoteRequest<Workspace>(remote, "workspace_create", { name: "api", path: api });
    await crew.reload();
    const mark = window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`);
    await mark.waitFor();
    await mark.click();
    await window.locator("[data-sidebar-panel]").getByText("api", { exact: true }).first().waitFor();

    const list = () => remoteRequest<Session[]>(remote!, "session_list", { workspaceId: workspace.id });
    const known = new Set((await list()).map((row) => row.id));
    await pressChord(crew, `${MOD}+n`);
    const session = await waitFor(async () => (await list()).find((row) => row.kind === "terminal" && !known.has(row.id)), {
      message: "the session is created on the machine",
    });
    const status = async () => (await remoteRequest<Session | null>(remote!, "session_get", { id: session.id }))?.status ?? null;
    const launches = async () =>
      (await crew.claudeLaunches()).filter((launch) => launch.argv.includes(session.id) && !launch.argv.includes("--strict-mcp-config"));

    await sendInChat(crew, "work 6");
    await waitFor(async () => (await launches()).length === 1, { message: "the machine starts the CLI", timeout: 15_000 });
    await waitFor(async () => (await lightIn(sessionRow(crew, session.name))) === "Working", { message: "the turn runs" });
    await waitFor(async () => (await heard(crew, api, session)).includes("work 6"), { message: "the CLI took the message in" });
    const [first] = await launches();

    // crewd goes down and systemd brings it back on the same port and data.
    await remote.stop();
    await remote.start();
    await waitFor(() => !alive(first!.pid), { timeout: 5000, message: "the CLI goes with the machine's crewd" });

    const again = await waitFor(async () => (await launches())[1], { message: "the machine starts the CLI again", timeout: 15_000 });
    assert.equal(argAfter(again.argv, "--resume"), session.id, JSON.stringify(again.argv));
    await waitFor(async () => (await lightIn(sessionRow(crew, session.name))) !== "Working" && (await status()) !== "working", {
      message: "the turn the restart cut off runs again and ends",
      timeout: 30_000,
    });
    assert.equal((await heard(crew, api, session)).filter((text) => text === "work 6").length, 2);

    // The next message reaches that CLI on the machine.
    await sendInChat(crew, "!touch typed-after-restart");
    await waitFor(() => existsSync(path.join(api, "typed-after-restart")), { message: "the message reaches the resumed CLI", timeout: 15_000 });
    assert.equal((await launches()).length, 2, "the message launched the CLI a third time");
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
