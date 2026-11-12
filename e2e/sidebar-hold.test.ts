// The sidebar holds its rows where they stand while the pointer is over the
// list: a session that would move (here, renamed under an ordering by name)
// keeps its place, and goes to its new one once the pointer leaves.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, sessionRow, waitFor } from "./harness.ts";

test("rows stay put under the pointer and settle once it leaves", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [app] = crew.workspaces;
  assert.ok(app);

  const made: Session[] = [];
  for (const name of ["bravo", "charlie", "delta"]) {
    made.push(
      await crew.request<Session>("session_create", { workspaceId: app.id, kind: "terminal", name, provider: "claude", model: "", description: "", autonomy: "full" }),
    );
  }
  const prefs = { scope: "all", ordering: "name", show: ["names", "diff", "updated", "status"], hiddenKinds: [], hiddenProviders: [], recency: "any", limit: 0, groupBy: "none", showWorktree: true, hiddenTrees: [] };
  await crew.request("state_set", { key: "sidebar:prefs", value: JSON.stringify(prefs) });
  await crew.reload();

  const order = () =>
    crew.window.evaluate(() =>
      [...document.querySelectorAll("[data-sidebar-panel] [data-session]")].map((el) => /alpha|bravo|charlie|delta/.exec(el.textContent ?? "")?.[0]).filter(Boolean),
    );
  const settles = (want: string[], message: string) =>
    waitFor(async () => (JSON.stringify(await order()) === JSON.stringify(want) ? true : null), { message, timeout: 5_000 });

  await settles(["bravo", "charlie", "delta"], "sorted by name");

  // Over the list: renamed to sort first, it keeps its place.
  await sessionRow(crew, "charlie").hover();
  const delta = made[2]!;
  await crew.request("session_update", { id: delta.id, name: "alpha", provider: delta.provider, model: delta.model, description: "", notifications: true, autonomy: delta.autonomy });
  await sessionRow(crew, "alpha").waitFor({ timeout: 5_000 });
  await crew.window.waitForTimeout(300);
  assert.deepEqual(await order(), ["bravo", "charlie", "alpha"], "held while the pointer is over the list");

  // Off the list: it goes where it sorts.
  const box = (await crew.window.locator("main").first().boundingBox()) ?? { x: 800, y: 400, width: 10, height: 10 };
  await crew.window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await settles(["alpha", "bravo", "charlie"], "settles once the pointer leaves");
});
