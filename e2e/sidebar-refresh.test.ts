// W9, the sidebar's refresh: a worktree git made and sessions crewd made or
// deleted, none of which the window heard about, reach the panel from the
// Refresh button on its Worktrees line, without the window losing focus. A
// worktree whose folder was deleted without git leaves, and git forgets it.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { gitWorktrees, launchCrew, sessionRow, worktreeHeader } from "./harness.ts";

test("W9: Refresh reads worktrees and sessions made or removed outside the window", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [app] = crew.workspaces;
  assert.ok(app);
  const panel = crew.window.locator("[data-sidebar-panel]");
  const refresh = panel.getByRole("button", { name: "Refresh", exact: true });
  await refresh.waitFor();

  // Git and crewd directly: no focus event, no session-created.
  await crew.git(app.path, "worktree", "add", "-b", "feat/outside", path.join(crew.root, "outside"));
  const made = await crew.request<Session>("session_create", {
    workspaceId: app.id,
    kind: "terminal",
    name: "made outside",
    provider: "claude",
    model: "",
    description: "",
    autonomy: "full",
  });
  assert.equal(await worktreeHeader(crew, "feat/outside").count(), 0, "the window has not read git yet");
  assert.equal(await sessionRow(crew, "made outside").count(), 0, "the window has not heard of the session");

  await refresh.click();
  await worktreeHeader(crew, "feat/outside").waitFor();
  await sessionRow(crew, "made outside").waitFor();

  // A delete crewd does not announce goes on the next refresh.
  await crew.request("session_delete", { id: made.id });
  await refresh.click();
  await sessionRow(crew, "made outside").waitFor({ state: "detached" });
  await worktreeHeader(crew, "feat/outside").waitFor();

  // Its folder deleted by hand, not by git: an orphan, pruned on the next read.
  const outside = path.join(crew.root, "outside");
  await rm(outside, { recursive: true, force: true });
  await refresh.click();
  await worktreeHeader(crew, "feat/outside").waitFor({ state: "detached" });
  const listed = await gitWorktrees(crew, app.path);
  assert.equal(listed.length, 1, `git still records the orphan: ${JSON.stringify(listed)}`);
  assert.notEqual(await crew.git(app.path, "branch", "--list", "feat/outside"), "", "its branch stays");
});
