// W6, an agent on a new branch: the agent sheet's "Works in" makes the
// worktree and puts the agent in it. A branch that cannot be made says so in
// the sheet and leaves git, the disk and crewd as they were.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session } from "../src/lib/types.ts";
import {
  currentWorktree,
  errorsIn,
  gitBranches,
  gitWorktrees,
  launchCrew,
  MOD,
  pressChord,
  sessions,
  waitFor,
  worktreeHeader,
  type Crew,
} from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

/** Everything a failed attempt must leave alone. */
async function snapshot() {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const folder = path.join(crew.home, ".crew/worktrees/app");
  return {
    worktrees: await gitWorktrees(crew, workspace.path),
    branches: await gitBranches(crew, workspace.path),
    sessions: (await sessions(crew, workspace.id)).map((session: Session) => session.id).sort(),
    folders: existsSync(folder) ? readdirSync(folder).sort() : [],
  };
}

/** ⇧⌘N, a name, and a new branch in "Works in"; the sheet is returned still open. */
async function agentOnBranch(name: string, branch: string): Promise<Locator> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+Shift+n`);
  const sheet = page.getByRole("dialog", { name: "New agent" });
  await sheet.waitFor();
  await sheet.getByPlaceholder("e.g. Research").fill(name);
  await sheet.getByRole("radiogroup", { name: "Works in" }).getByRole("radio", { name: "New branch" }).fill(branch);
  return sheet;
}

/** Create, and wait for the attempt to settle: the button spins while it saves. */
async function create(sheet: Locator): Promise<void> {
  const button = sheet.getByRole("button", { name: "Create agent" });
  await button.click();
  await waitFor(async () => (await sheet.count()) === 0 || (await button.isEnabled()), {
    message: "the sheet settles after Create",
  });
}

/** A branch the sheet cannot use: an error in the sheet, and nothing new anywhere. */
async function refused(branch: string, name: string): Promise<void> {
  const before = await snapshot();
  const sheet = await agentOnBranch(name, branch);
  try {
    await create(sheet);
    assert.ok(await sheet.isVisible(), `the sheet stays open on "${branch}"`);
    assert.deepEqual(await snapshot(), before, `"${branch}" leaves git, the disk and crewd as they were`);
    const shown = await waitFor(async () => (await errorsIn(sheet)).length > 0, { timeout: 3000 }).catch(() => false);
    assert.ok(shown, `the sheet says nothing about "${branch}"; git refused it and nothing was made`);
  } finally {
    if (await sheet.isVisible()) await sheet.getByRole("button", { name: "Cancel" }).click();
    await sheet.waitFor({ state: "detached" });
  }
}

test("W6: an agent made on a new branch gets its own worktree and works in it", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tree = path.join(crew.home, ".crew/worktrees/app/feat-agent-work");

  const sheet = await agentOnBranch("Builder", "feat/agent-work");
  await create(sheet);
  await sheet.waitFor({ state: "detached" });

  const made = await waitFor(async () => (await gitWorktrees(crew, workspace.path)).find((entry) => entry.path === tree), {
    message: "git lists the agent's worktree",
  });
  assert.equal(made.branch, "refs/heads/feat/agent-work");
  const agent = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row) => row.kind === "agent" && row.name === "Builder"),
    { message: "crewd has the agent" },
  );
  assert.equal(agent.worktree, tree);
  // The window follows the agent into its worktree.
  await worktreeHeader(crew, "feat/agent-work").and(currentWorktree(crew)).waitFor();
});

test("W6b: a branch name the sheet knows is invalid is refused in the sheet", async () => {
  await refused("bad..name", "Second");
});

test("W6c: a branch checked out elsewhere is refused by git, and the sheet says so", async () => {
  // main is the main checkout's own branch: git will not check it out twice.
  await refused("main", "Third");
});

test("W6d: a branch name only git knows is invalid is refused, and the sheet says so", async () => {
  // A path component starting with a dot: check-ref-format refuses it, branchError does not look.
  await refused("feat/.hidden", "Fourth");
});
