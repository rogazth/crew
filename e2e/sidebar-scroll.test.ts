// The sidebar is one panel for every workspace: switching starts the next one's
// list at its top, not at the offset the last one was left at. Within a
// workspace, picking a session leaves the scroll where it is.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, waitFor } from "./harness.ts";

const SCROLLER = "[data-sidebar-panel] > div";

type Probe = { commits: number; scrolls: number };

test("switching workspaces starts the sidebar at its top", async (t) => {
  const crew = await launchCrew({ repos: ["app", "side"] });
  t.after(() => crew.close());
  const page = crew.window;
  const [app, side] = crew.workspaces;
  assert.ok(app && side, "both workspaces were seeded");

  // Every row listed, enough of them to scroll, in both workspaces.
  await crew.request("state_set", { key: "sidebar:prefs", value: JSON.stringify({ limit: 0 }) });
  for (const workspace of [app, side]) {
    for (let i = 0; i < 30; i++) {
      await crew.request<Session>("session_create", {
        workspaceId: workspace.id,
        kind: "terminal",
        name: `${workspace.name} ${i}`,
        provider: "claude",
        model: "",
        description: "",
        autonomy: "full",
        worktree: null,
      });
    }
  }
  // React's commits, counted through the devtools hook it looks for as it loads.
  await page.addInitScript(() => {
    const probe = { commits: 0, scrolls: 0 };
    (window as unknown as { probe: Probe }).probe = probe;
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: object }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberRoot: () => probe.commits++,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
    };
  });
  await crew.reload();

  const scroller = page.locator(SCROLLER).first();
  const top = () => scroller.evaluate((el) => el.scrollTop);
  const scrollToEnd = async () => {
    await waitFor(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 200), {
      message: "the list overflows",
    });
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.addEventListener("scroll", () => (window as unknown as { probe: Probe }).probe.scrolls++);
    });
    assert.ok((await top()) > 200, "the list scrolled");
  };
  const switchTo = async (name: string, id: string) => {
    await page.evaluate(() => Object.assign((window as unknown as { probe: Probe }).probe, { commits: 0, scrolls: 0 }));
    const started = Date.now();
    await page.locator(`[data-rail-marks] button[data-nav][aria-label="${name}"]`).click();
    await waitFor(async () => (await crew.request("active_workspace_get")) === id, { message: `${name} is active` });
    await waitFor(() => page.getByText(`${name} 0`, { exact: true }).isVisible(), {
      message: `${name}'s rows are listed`,
    });
    const took = Date.now() - started;
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => ({ ...(window as unknown as { probe: Probe }).probe }));
    console.log(`switch to ${name}: ${took}ms, ${probe.commits} commits, ${probe.scrolls} scroll events`);
    return probe;
  };

  await waitFor(() => page.getByText("app 0", { exact: true }).isVisible(), { message: "app's rows are listed" });
  await scrollToEnd();
  await switchTo("side", side.id);
  assert.equal(await top(), 0, "side starts at its top");

  await scrollToEnd();
  await switchTo("app", app.id);
  assert.equal(await top(), 0, "app starts at its top");

  // Within a workspace, picking a row keeps the offset.
  await scroller.evaluate((el) => (el.scrollTop = 120));
  const held = await top();
  // A row already in view: a locator's click would scroll its row into view first.
  const point = await scroller.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>("button[data-session]")].find((r) => r.getBoundingClientRect().top > box.top + 60);
    const at = row!.getBoundingClientRect();
    return { x: at.left + at.width / 2, y: at.top + at.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(300);
  assert.equal(await top(), held, "picking a session keeps the scroll");
});
