// W8, worktrees that cannot be: a workspace that is not a git repo, and a
// branch whose folder another branch already took. The dialog says why, and
// nothing is left on disk or in git.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Locator } from "playwright-core";
import type { Worktree } from "../src/lib/types.ts";
import {
  errorsIn,
  gitBranches,
  gitWorktrees,
  launchCrew,
  MOD,
  WORKTREE_MOD,
  pressChord,
  returnToWindow,
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

/** ⌃⌘N with `branch`, ↵, and the dialog left open with whatever it says. */
async function tryWorktree(branch: string) {
  const page = crew.window;
  await pressChord(crew, `${WORKTREE_MOD}+n`);
  const input = page.getByRole("textbox", { name: "Branch" });
  await input.waitFor();
  await input.fill(branch);
  await input.press("Enter");
  // The dialog is the input's nearest container that also holds its messages.
  const dialog = page.locator("[role=dialog]").filter({ has: input });
  const errors = await waitFor(async () => {
    const shown = await errorsIn(dialog);
    return shown.length > 0 && shown;
  }, { timeout: 5000 }).catch(() => [] as string[]);
  return { dialog, input, errors };
}

async function dismiss(input: Locator) {
  if (await input.isVisible()) await input.press("Escape");
  await input.waitFor({ state: "detached" });
}

test("W8: a branch whose folder another branch took is refused, and git is left alone", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // feat/a lives in ~/.crew/worktrees/app/feat-a; so would feat-a.
  const taken = await crew.request<Worktree>("worktree_add", { path: workspace.path, branch: "feat/a" });
  assert.equal(path.basename(taken.path), "feat-a");
  await returnToWindow(crew);
  await worktreeHeader(crew, "feat/a").waitFor();
  const before = { worktrees: await gitWorktrees(crew, workspace.path), branches: await gitBranches(crew, workspace.path) };

  const { input, errors } = await tryWorktree("feat-a");
  try {
    assert.ok(errors.length > 0, "the dialog says why feat-a cannot be made");
    assert.deepEqual(
      { worktrees: await gitWorktrees(crew, workspace.path), branches: await gitBranches(crew, workspace.path) },
      before,
      "git has no new worktree or branch",
    );
    assert.equal(await worktreeHeader(crew, "feat-a").count(), 0);
  } finally {
    await dismiss(input);
  }
});

test("W8b: a workspace that is not a repo has one branchless line, and a worktree for it fails in the open", async () => {
  const folder = path.join(crew.root, "repos/notes");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "todo.md"), "- one\n");
  const notes = await crew.addWorkspace(folder);
  const worktrees = path.join(crew.home, ".crew/worktrees");
  const madeBefore = existsSync(worktrees) ? readdirSync(worktrees).sort() : [];

  // Git knows no worktrees there: the panel shows the folder alone, without a branch.
  const [only, ...rest] = await crew.request<Worktree[]>("worktree_list", { path: notes.path });
  assert.ok(only && rest.length === 0 && only.branch === null);
  const lines = crew.window.locator("[data-sidebar-panel] button[data-nav][aria-expanded]");
  await worktreeHeader(crew, "No branch").waitFor();
  assert.equal(await lines.count(), 1);

  const { input, errors } = await tryWorktree("feat/x");
  try {
    assert.ok(errors.length > 0, "the dialog shows git's error");
    assert.match(errors.join("\n"), /not a git repository/i);
    assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees).sort() : [], madeBefore, "no folder was made for it");
    assert.ok(!existsSync(path.join(folder, ".git")), "the folder did not become a repo");
    assert.equal(await lines.count(), 1);
  } finally {
    await dismiss(input);
  }
});
