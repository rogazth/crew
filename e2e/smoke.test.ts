import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, tabBar, type Crew } from "./harness.ts";

const WORKSPACE = "smoke-workspace";

let crew: Crew;
let launchedIn = 0;

before(async () => {
  const start = performance.now();
  crew = await launchCrew({ workspace: WORKSPACE });
  launchedIn = Math.round(performance.now() - start);
});

after(() => crew?.close());

test("opens on the seeded workspace", async (t) => {
  t.diagnostic(`launchCrew took ${launchedIn}ms`);
  assert.ok(await tabBar(crew.window).isVisible(), "the tab bar is visible");
  const sidebar = crew.window.locator('[data-sidebar="sidebar"]');
  await sidebar.getByText(WORKSPACE).first().waitFor({ state: "visible" });
});

test("loads the built renderer from disk, not the dev server", async () => {
  assert.equal(await crew.window.evaluate(() => window.location.protocol), "file:");
});

test("keeps its data in the temporary directory", async () => {
  // Chromium's --user-data-dir sets userData, which crewd gets as --data-dir.
  const userData = await crew.app.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(realpathSync(userData), realpathSync(crew.dataDir));
  assert.ok(existsSync(path.join(crew.dataDir, "crew.sqlite3")), "crewd wrote its store there");
});
