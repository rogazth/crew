// W1, the life of a worktree: made from the keyboard, worked in from a
// terminal, dirtied, and removed, with git, the disk and crewd as witnesses.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  claudeStarts,
  gitWorktrees as listWorktrees,
  launchCrew,
  MOD,
  returnToWindow,
  sessions,
  waitFor,
  worktreeHeader as header,
  type Crew,
} from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew({ repos: [{ name: "app", files: { "README.md": "# app\n", "src/main.txt": "one\n" } }] });
});

after(async () => {
  await crew?.close();
});

const worktreeHeader = (label: string) => header(crew, label);
const gitWorktrees = (repo: string) => listWorktrees(crew, repo);

test("W1: a worktree is made, worked in, dirtied and removed", async () => {
  const page = crew.window;
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const repo = workspace.path;
  const tree = path.join(crew.home, ".crew/worktrees/app/feat-login");

  // ⌥⌘N: the branch typed over whatever the dialog offers, ↵ makes it.
  await page.keyboard.press(`${MOD}+Alt+n`);
  const branch = page.getByRole("textbox", { name: "Branch" });
  await branch.waitFor();
  await branch.fill("feat/login");
  await branch.press("Enter");
  await branch.waitFor({ state: "detached" });

  // Git has it where crew puts worktrees, on the new branch, and the window is on it.
  const made = await waitFor(async () => (await gitWorktrees(repo)).find((entry) => entry.path === tree), {
    message: "git lists the new worktree",
  });
  assert.equal(made.branch, "refs/heads/feat/login");
  assert.ok(existsSync(tree));
  const header = worktreeHeader("feat/login");
  await header.and(page.locator('[aria-current="true"]')).waitFor();

  // ⌘N: a terminal session in the worktree, its CLI started there.
  await page.keyboard.press(`${MOD}+n`);
  const session = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row) => row.kind === "terminal"),
    { message: "the new session reaches crewd" },
  );
  assert.equal(session.worktree, tree);
  // The fake claude drops the SessionStart record once it reads keys.
  await waitFor(async () => (await claudeStarts(crew, session.id)).length > 0, {
    message: "the terminal's CLI starts",
  });
  await page.locator(".xterm-helper-textarea:focus").waitFor({ state: "attached" });
  await page.keyboard.type("!pwd > here.txt");
  await page.keyboard.press("Enter");
  const written = path.join(tree, "here.txt");
  const pwd = await waitFor(async () => (await readFile(written, "utf8")).trim(), {
    message: "the terminal's pwd lands in the worktree",
  });
  assert.equal(pwd, tree);

  // A tracked file edited outside crew too. Coming back to the window re-reads
  // git: the line's diff counts the edit. (Dirt the window never re-read is W2.)
  await appendFile(path.join(tree, "README.md"), "more\n");
  const dirty = (await crew.git(tree, "status", "--porcelain")).split("\n").filter(Boolean).length;
  assert.ok(dirty >= 2, `untracked here.txt and the edited README, got ${dirty}`);
  await returnToWindow(crew);
  await header.filter({ hasText: "+1" }).waitFor();

  // Remove from the worktree's menu: the prompt counts what git sees and who works there.
  const inTree = (await sessions(crew, workspace.id)).filter((row) => row.worktree === tree);
  const tabId = await page
    .locator(`[data-tab-strip] [role="tab"][data-tab-id]`)
    .filter({ hasText: session.name })
    .getAttribute("data-tab-id");
  assert.ok(tabId, "the session has a tab");

  await header.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Remove Worktree…" }).click();
  const alert = page.getByRole("alertdialog");
  await alert.getByText('Remove worktree "feat/login"?').waitFor();
  const description = await alert.innerText();
  assert.match(description, new RegExp(`\\b${dirty} uncommitted changes? (is|are) lost`), description);
  assert.match(description, new RegExp(`\\b${inTree.length} sessions? ends? with it`), description);

  await alert.getByRole("button", { name: "Remove" }).click();
  await alert.waitFor({ state: "detached" });

  // The folder and its session are gone everywhere; the branch stays.
  await waitFor(() => !existsSync(tree), { message: "the worktree's folder is deleted" });
  assert.equal((await gitWorktrees(repo)).find((entry) => entry.path === tree), undefined);
  await crew.git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feat/login");
  await waitFor(async () => (await crew.request<Session | null>("session_get", { id: session.id })) === null, {
    message: "crewd deletes the worktree's session",
  });
  assert.equal(await page.locator(`[data-tab-strip] [data-tab-id="${tabId}"]`).count(), 0);

  // The window is back on the main checkout.
  await worktreeHeader("main").and(page.locator('[aria-current="true"]')).waitFor();
  assert.equal(await header.count(), 0);

  // Nor does crewd keep the strip the worktree had: the same branch checked out
  // again lands on the same path, and a saved tab would come back as a ghost.
  const savedTabs = () => crew.request<string | null>("state_get", { key: `tabs:${workspace.id}@${tree}` });
  await waitFor(async () => !(await savedTabs())?.includes(session.id), {
    timeout: 5000,
    message: "no saved strip keeps the session's tab",
  });
});
