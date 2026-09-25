// T4 and T6: a claude terminal mid-turn when the app goes away, by a quit and
// relaunch or by crewd dying under it. The CLI dies with its terminal either
// way, so nothing is running once the window is back: the row must not keep
// saying Working. What was unread stays unread, names stay, and the CLI comes
// back on the same conversation (`--resume <id>`, in the fake's own log)
// without its redraw passing for a new turn.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "../src/lib/types.ts";
import {
  crewdPid,
  holdsFor,
  launchCrew,
  lightIn,
  newTerminal,
  sessionRow,
  sessionTab,
  storedStatus,
  typeInTerminal,
  waitFor,
  type ClaudeLaunch,
  type Crew,
} from "./harness.ts";

/** The row's light and crewd's status, for a failure message or a check. */
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

/** The launch of `session`'s CLI after the first `skip` launches, once there is one. */
async function relaunch(crew: Crew, session: Session, skip: number, timeout = 15_000): Promise<ClaudeLaunch> {
  return waitFor(
    async () => (await crew.claudeLaunches()).slice(skip).find((run) => run.argv.includes(session.id)),
    { timeout, message: `${session.name}'s CLI starts again` },
  );
}

/** The CLI has resumed and reads keys: its SessionStart hook reported a resume. */
async function resumed(crew: Crew, session: Session): Promise<void> {
  const record = path.join(crew.userData, "claude-bind", `${session.id}.json`);
  await waitFor(
    async () => (JSON.parse(await readFile(record, "utf8")) as { source?: string }).source === "resume",
    { timeout: 15_000, message: `${session.name}'s CLI reports a resume` },
  );
}

/** Samples `check` in the background until stopped; resolves to what the failing samples said. */
function watch(check: () => Promise<true | string>): { stop(): Promise<string[]> } {
  const failures: string[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const verdict = await check();
      if (verdict !== true && failures.length < 5) failures.push(verdict);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return failures;
    },
  };
}

const argAfter = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

test("T4: quitting mid-turn: after the relaunch nothing reads Working, Unread survives, and the CLI resumes without a phantom turn", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  // b finishes a turn out of sight: Unread.
  const a = await newTerminal(crew, workspace.id);
  const b = await newTerminal(crew, workspace.id);
  await typeInTerminal(crew, "work 2");
  await waitFor(async () => (await storedStatus(crew, b.id)) === "working", { message: "b's turn starts" });
  await sessionTab(crew, a).click();
  await reaches(crew, b, "Unread", "done");

  // a is mid-turn, on screen, when the app quits.
  await typeInTerminal(crew, "work 30");
  await reaches(crew, a, "Working", "working", 5000);
  const before = (await crew.claudeLaunches()).length;
  let atQuit: string | null = null;
  crew = await crew.restart(async () => {
    const db = new DatabaseSync(path.join(crew.userData, "crew.sqlite3"), { readOnly: true });
    try {
      atQuit = (db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.id) as { status: string }).status;
    } finally {
      db.close();
    }
  });
  t.diagnostic(`crewd held a as "${atQuit}" when the app was down`);

  // From the first paint to the end of the test, a never reads Working.
  const stale = watch(async () => {
    const now = await state(crew, a).catch(() => null);
    return !now || (now.light !== "Working" && now.stored !== "working") || JSON.stringify(now);
  });
  t.after(() => stale.stop());

  // a's CLI comes back on its conversation, by the id it had.
  const again = await relaunch(crew, a, before);
  assert.equal(argAfter(again.argv, "--resume"), a.id, `a resumes its conversation: ${JSON.stringify(again.argv)}`);
  assert.equal(argAfter(again.argv, "--session-id"), undefined);

  // The resumed CLI repaints its conversation for about a second; that is no turn.
  await resumed(crew, a);
  await holdsFor(
    4000,
    async () => {
      const [now, other] = await Promise.all([state(crew, a), state(crew, b)]);
      if (now.light === "Working" || now.stored === "working") return `a: ${JSON.stringify(now)}`;
      return (other.light === "Unread" && other.stored === "done") || `b: ${JSON.stringify(other)}`;
    },
    "after the resume, a reads a turn or b stops reading Unread",
  );
  await reaches(crew, a, "Idle", "idle", 3000);
  const seen = await stale.stop();
  assert.deepEqual(seen, [], "a read Working after the relaunch");

  // A terminal starts once its pane has a size, so b's CLI waits until b is
  // looked at; the sessions drive (70e6b62) has every tab resume in the background.
  await t.test("b's CLI resumes out of sight too", { todo: "Q2: out-of-sight tabs start their CLI only when shown (TerminalView.tsx applySize)" }, async () => {
    const run = await relaunch(crew, b, before, 3000);
    assert.equal(argAfter(run.argv, "--resume"), b.id);
  });
});

test("T6: crewd killed mid-turn: the app brings it back, the row settles to what really runs, and every session keeps its name", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;

  const s1 = await newTerminal(crew, workspace.id);
  const name = `Reconcile ${Date.now().toString(36)}`;
  await typeInTerminal(crew, `title ${name}`);
  await waitFor(async () => (await crew.request<Session | null>("session_get", { id: s1.id }))?.name === name, {
    message: "crewd takes the CLI's name",
  });
  const s2 = await newTerminal(crew, workspace.id);
  await typeInTerminal(crew, "hello");
  await waitFor(async () => (await storedStatus(crew, s2.id)) === "working", { message: "s2's turn starts" });
  await waitFor(async () => (await storedStatus(crew, s2.id)) === "idle", { message: "s2's turn ends" });
  const stored = (await crew.request<Session[]>("session_list", { workspaceId: workspace.id }))
    .map((session) => ({ id: session.id, name: session.name }))
    .sort((x, y) => x.id.localeCompare(y.id));

  await sessionTab(crew, s1).click();
  const named = { ...s1, name };
  await typeInTerminal(crew, "work 20");
  await reaches(crew, named, "Working", "working", 5000);

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

  // Every session and its name are still there.
  const after = (await crew.request<Session[]>("session_list", { workspaceId: workspace.id }))
    .map((session) => ({ id: session.id, name: session.name }))
    .sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(after, stored);

  // The window starts the CLI again on its conversation, and nothing is running
  // in it: the row settles to rest instead of spinning on for a turn that died.
  const again = await relaunch(crew, s1, before);
  assert.equal(argAfter(again.argv, "--resume"), s1.id);
  await resumed(crew, s1);
  await reaches(crew, named, "Idle", "idle", 5000);
  await holdsFor(
    4000,
    async () => {
      const now = await state(crew, named);
      return (now.light !== "Working" && now.stored !== "working") || JSON.stringify(now);
    },
    `${name} goes back to Working`,
  );

  // The CLI that ran the turn went down with crewd's terminal, rather than
  // running on unseen beside the one resumed in its place.
  const gone = await waitFor(
    () => {
      try {
        process.kill(cli.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeout: 5000 },
  ).catch(() => false);
  assert.ok(gone, `the CLI crewd ran before the crash (pid ${cli.pid}) is still running`);
});
