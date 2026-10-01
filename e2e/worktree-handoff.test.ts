// A session in the main checkout hands its work to a branch of its own:
// `create_worktree` makes the worktree and a terminal session in it, whose CLI
// starts with the task as its first prompt. The caller stays where it was, and
// the window shows the new worktree and its session without being refocused.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  gitWorktrees,
  launchCrew,
  newTerminal,
  sessionRow,
  sessions,
  typeInTerminal,
  waitFor,
  worktreeHeader,
} from "./harness.ts";

test("a terminal in the main checkout hands its task to a new session on a worktree", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);
  const shell = await newTerminal(crew, main.id);

  const launch = (await crew.claudeLaunches()).find((row) => row.argv.includes(shell.id));
  assert.ok(launch, "the terminal's CLI started");
  const config = JSON.parse(launch.argv[launch.argv.indexOf("--mcp-config") + 1] ?? "{}") as {
    mcpServers: { crew: { command: string } };
  };
  const crewCli = path.join(path.dirname(config.mcpServers.crew.command), "crew");

  const out = path.join(launch.cwd, `handoff-${Date.now().toString(36)}.txt`);
  const task = "Build the login form.";
  await typeInTerminal(crew, `!'${crewCli}' worktrees new feat/handoff --task '${task}' --json > '${out}' 2>&1`);
  const answer = await waitFor(() => readFile(out, "utf8").catch(() => ""), {
    timeout: 30_000,
    message: "crew worktrees new answers",
  });
  const handed = JSON.parse(answer) as { worktree: string; branch: string; session: { id: string; name: string } };
  assert.equal(handed.branch, "feat/handoff", answer);
  assert.equal(handed.session.name, "feat/handoff", answer);

  // Git has it where Crew keeps worktrees, on the branch.
  const trees = await gitWorktrees(crew, main.path);
  const tree = trees.find((row) => row.path === handed.worktree);
  assert.ok(tree, `git does not list ${handed.worktree}: ${JSON.stringify(trees)}`);
  assert.equal(tree.branch, "refs/heads/feat/handoff");
  assert.ok(handed.worktree.startsWith(path.join(crew.home, ".crew/worktrees/")), handed.worktree);

  // The session works in it; the terminal stays in the main checkout.
  const rows = await sessions(crew, main.id);
  const handedTo = rows.find((row: Session) => row.id === handed.session.id);
  assert.ok(handedTo, "crewd has the new session");
  assert.equal(handedTo.kind, "terminal");
  assert.equal(handedTo.worktree, handed.worktree);
  assert.equal(rows.find((row: Session) => row.id === shell.id)?.worktree ?? null, null);

  // Its tab opens behind the one on screen, and its CLI starts on the task.
  const started = await waitFor(
    async () =>
      (await crew.claudeLaunches()).find((row) => row.argv.includes(handedTo.id) && row.argv.some((arg) => arg.includes(task))),
    { timeout: 15_000, message: "the new session's CLI starts on the task" },
  );
  assert.equal(started.cwd, handed.worktree);

  // The window lists the worktree, with no focus to prompt a reread, and the
  // session under it. The window stays on the main checkout, so it comes folded.
  const header = worktreeHeader(crew, "feat/handoff");
  await header.waitFor({ timeout: 15_000 });
  assert.equal(await header.getAttribute("aria-expanded"), "false");
  await header.click();
  await sessionRow(crew, "feat/handoff").waitFor({ timeout: 15_000 });
});
