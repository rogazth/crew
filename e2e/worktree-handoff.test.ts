// A session in the main checkout hands its work to a branch of its own:
// `start_session` makes the worktree and a session in it,
// launched by the caller, whose CLI Crew drives over the protocol with the
// prompt as its first message (in an envelope naming the caller).
// The caller stays where it was, and the window shows the new worktree and its
// session without being refocused.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  gitWorktrees,
  goToWorktree,
  launchCrew,
  newSession,
  sendInChat,
  sessionRow,
  sessionTab,
  sessions,
  storedStatus,
  waitFor,
  worktreeHeader,
} from "./harness.ts";

test("a session in the main checkout hands its task to a new session on a worktree", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);
  const shell = await newSession(crew, main.id);
  // Its first message starts the CLI, which the next one then reaches over the protocol.
  await sendInChat(crew, "hello");
  const launch = await waitFor(async () => (await crew.claudeLaunches()).find((row) => row.argv.includes(shell.id)), {
    message: "the session's CLI starts",
  });
  await waitFor(async () => (await storedStatus(crew, shell.id)) === "idle", { message: "the first turn ends" });
  const config = JSON.parse(launch.argv[launch.argv.indexOf("--mcp-config") + 1] ?? "{}") as {
    mcpServers: { crew: { command: string } };
  };
  const crewCli = path.join(path.dirname(config.mcpServers.crew.command), "crew");

  const out = path.join(launch.cwd, `handoff-${Date.now().toString(36)}.txt`);
  const task = "Build the login form.";
  await sendInChat(
    crew,
    `!'${crewCli}' sessions start --worktree feat/handoff --name feat/handoff --json -- '${task}' > '${out}' 2>&1`,
  );
  const answer = await waitFor(() => readFile(out, "utf8").catch(() => ""), {
    timeout: 30_000,
    message: "crew sessions start answers",
  });
  const handed = JSON.parse(answer) as { id: string; name: string; worktree: string; branch: string };
  assert.equal(handed.branch, "feat/handoff", answer);
  assert.equal(handed.name, "feat/handoff", answer);

  // Git has it where Crew keeps worktrees, on the branch.
  const trees = await gitWorktrees(crew, main.path);
  const tree = trees.find((row) => row.path === handed.worktree);
  assert.ok(tree, `git does not list ${handed.worktree}: ${JSON.stringify(trees)}`);
  assert.equal(tree.branch, "refs/heads/feat/handoff");
  assert.ok(handed.worktree.startsWith(crew.worktrees + path.sep), handed.worktree);

  // The session works in it; the caller stays in the main checkout.
  const rows = await sessions(crew, main.id);
  const handedTo = rows.find((row: Session) => row.id === handed.id);
  assert.ok(handedTo, "crewd has the new session");
  assert.equal(handedTo.kind, "terminal");
  assert.equal(handedTo.launchedBy, shell.id);
  assert.equal(handedTo.parentId, undefined);
  assert.equal(handedTo.worktree, handed.worktree);
  assert.equal(rows.find((row: Session) => row.id === shell.id)?.worktree ?? null, null);

  // The session is a chat: Crew drives its CLI over the protocol, so the task
  // is its first message, in an envelope naming who launched it, and not on
  // the command line.
  const started = await waitFor(
    async () => (await crew.claudeLaunches()).find((row) => row.argv.includes(handedTo.id)),
    { timeout: 15_000, message: "the new session's CLI starts" },
  );
  assert.equal(started.cwd, handed.worktree);
  assert.ok(started.argv.join(" ").includes("--input-format stream-json"), started.argv.join(" "));
  assert.ok(!started.argv.some((arg) => arg.includes(task)), "the task is not on the command line");

  // The window lists the worktree, with no focus to prompt a reread, and the
  // session under it. The window stays on the main checkout, so it comes folded.
  const header = worktreeHeader(crew, "feat/handoff");
  await header.waitFor({ timeout: 15_000 });
  assert.equal(await header.getAttribute("aria-expanded"), "false");
  await header.click();
  const row = sessionRow(crew, "feat/handoff");
  await row.waitFor({ timeout: 15_000 });

  // Its chat has the task as the message it was launched with, from the
  // caller, and the fake claude's reply to it.
  await goToWorktree(crew, "feat/handoff");
  await sessionTab(crew, handedTo).click();
  const reply = crew.window.getByText(/^Reply 1: .*Build the login form\./).first();
  await reply.waitFor({ timeout: 15_000 });
  assert.match((await reply.textContent()) ?? "", new RegExp(`${shell.id}|${shell.name}`), "the envelope names who launched it");
});
