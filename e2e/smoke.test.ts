// The app starts from the built renderer on the sandbox's data, and its
// provider CLI is the harness's fake claude.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, sessions, startChat, waitFor, workspaceRail, type Crew } from "./harness.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
});

test("opens the seeded workspace from dist/ on the sandbox's data", async () => {
  const url = new URL(crew.window.url());
  assert.equal(url.protocol, "file:");
  assert.ok(url.pathname.endsWith("/dist/index.html"), url.href);

  const userData = await crew.app.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(userData, crew.userData);
  assert.ok(existsSync(path.join(crew.userData, "crew.sqlite3")), "crewd keeps its database in userData");

  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const rail = workspaceRail(crew);
  await rail.getByRole("button", { name: workspace.name, exact: true }).and(crew.window.locator('[aria-current="true"]')).waitFor();
});

test("claude resolves to the fake, and a new session launches it in the workspace once it has a message", async () => {
  assert.deepEqual(await crew.request("agent_installed", { names: ["claude"] }), ["claude"]);
  const resolved = await crew.request<{ path: string }>("agent_resolve_claude");
  assert.equal(resolved.path, path.join(crew.home, ".local/bin/claude"));

  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  // ⌘N is the start screen; the session is made by its first send.
  const session = await startChat(crew, "hello", () => sessions(crew, workspace.id));
  const launch = await waitFor(async () => (await crew.claudeLaunches()).find((row) => row.argv.includes(session.id)), {
    message: "the fake claude starts",
  });
  assert.equal(launch.cwd, workspace.path);
  assert.equal(launch.argv[launch.argv.indexOf("--session-id") + 1], session.id);
});
