// A session in the main checkout hands its work to a branch of its own:
// `create_worktree` makes the worktree, an agent in it, and gives that agent
// the task. The caller stays where it was, and the window shows the new
// worktree and its agent without being refocused.
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

type Transcript = { blocks: { text: string }[] };

test("a terminal in the main checkout hands its task to a new agent on a worktree", async (t) => {
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
  const handed = JSON.parse(answer) as { worktree: string; branch: string; agent: { id: string; name: string } };
  assert.equal(handed.branch, "feat/handoff", answer);
  assert.equal(handed.agent.name, "feat/handoff", answer);

  // Git has it where Crew keeps worktrees, on the branch.
  const trees = await gitWorktrees(crew, main.path);
  const tree = trees.find((row) => row.path === handed.worktree);
  assert.ok(tree, `git does not list ${handed.worktree}: ${JSON.stringify(trees)}`);
  assert.equal(tree.branch, "refs/heads/feat/handoff");
  assert.ok(handed.worktree.startsWith(path.join(crew.home, ".crew/worktrees/")), handed.worktree);

  // The agent works in it; the terminal stays in the main checkout.
  const rows = await sessions(crew, main.id);
  const agent = rows.find((row: Session) => row.id === handed.agent.id);
  assert.ok(agent, "crewd has the new agent");
  assert.equal(agent.kind, "agent");
  assert.equal(agent.worktree, handed.worktree);
  assert.equal(rows.find((row: Session) => row.id === shell.id)?.worktree ?? null, null);

  // It has the task: its first turn is on it.
  await waitFor(
    async () => {
      const chat = await crew.request<Transcript>("transcript_tail", { sessionId: agent.id });
      return chat.blocks.some((block) => block.text.includes(task));
    },
    { timeout: 15_000, message: "the new agent reads the task" },
  );

  // The window lists the worktree, with no focus to prompt a reread, and the
  // agent under it. The window stays on the main checkout, so it comes folded.
  const header = worktreeHeader(crew, "feat/handoff");
  await header.waitFor({ timeout: 15_000 });
  assert.equal(await header.getAttribute("aria-expanded"), "false");
  await header.click();
  await sessionRow(crew, "feat/handoff").waitFor({ timeout: 15_000 });
});
