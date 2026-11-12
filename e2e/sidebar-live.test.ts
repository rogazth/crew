// W9, the sidebar keeps up on its own: a worktree git made and sessions crewd
// made or deleted, none of them through the window, reach the panel as they
// happen, with no focus event and no reload. A worktree whose folder was
// deleted without git leaves too, and git forgets it.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { gitWorktrees, launchCrew, sessionRow, worktreeHeader } from "./harness.ts";

const SOON = { timeout: 5_000 };

test("W9: worktrees and sessions made or removed outside the window reach the sidebar at once", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [app] = crew.workspaces;
  assert.ok(app);
  await crew.window.locator("[data-sidebar-panel]").getByRole("button", { name: "Customize sidebar" }).waitFor();
  // The window has listed the repo's worktrees, which is when crewd starts watching it.
  await worktreeHeader(crew, "main").waitFor();

  // Git and crewd directly: the window is not told by anything it did.
  await crew.git(app.path, "worktree", "add", "-b", "feat/outside", path.join(crew.root, "outside"));
  await worktreeHeader(crew, "feat/outside").waitFor(SOON);

  const made = await crew.request<Session>("session_create", {
    workspaceId: app.id,
    kind: "terminal",
    name: "made outside",
    provider: "claude",
    model: "",
    description: "",
    autonomy: "full",
  });
  await sessionRow(crew, "made outside").waitFor(SOON);

  await crew.request("session_delete", { id: made.id });
  await sessionRow(crew, "made outside").waitFor({ state: "detached", ...SOON });
  await worktreeHeader(crew, "feat/outside").waitFor();

  // Its folder deleted by hand, not by git: an orphan, pruned as the window reads it again.
  await rm(path.join(crew.root, "outside"), { recursive: true, force: true });
  await worktreeHeader(crew, "feat/outside").waitFor({ state: "detached", ...SOON });
  const listed = await gitWorktrees(crew, app.path);
  assert.equal(listed.length, 1, `git still records the orphan: ${JSON.stringify(listed)}`);
  assert.notEqual(await crew.git(app.path, "branch", "--list", "feat/outside"), "", "its branch stays");
});
