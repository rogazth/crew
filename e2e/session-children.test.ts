// Plans 2026-10-05 (UI decision 1) and 2026-10-12 (decisions 5, 10, 26): a
// session started with start_session lives in whoever started it, not in the
// sidebar. It shows in the parent's status line and its Work sheet (there is
// no chip bar) and opens in place, in the same tab. The session's CLI starts
// it from its own shell with `crew sessions delegate`, with the session's
// token, so the parent is the session; the fake opencode 2.x
// (e2e/bin/opencode) answers.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "../src/lib/types.ts";
import { installFakeOpencode, launchCrew, newSession, sendInChat, stripTabIds, waitFor, type Crew } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CREW = path.join(ROOT, "target/debug/crew");

const sessions = (crew: Crew, workspaceId: string) => crew.request<Session[]>("session_list", { workspaceId });

/** The window as it is, light and dark. */
async function shots(crew: Crew, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await crew.window.emulateMedia({ colorScheme: "light" });
  await crew.window.screenshot({ path: path.join(dir, `${name}.png`) });
  await crew.window.emulateMedia({ colorScheme: "dark" });
  await crew.window.screenshot({ path: path.join(dir, `${name}-dark.png`) });
  await crew.window.emulateMedia({ colorScheme: null });
}

test("a session a session started is in the status line and the Work sheet, and opens in the same tab", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);
  await installFakeOpencode(crew);

  const shell = await newSession(crew, main.id);
  await sendInChat(crew, `!'${CREW}' sessions delegate --provider opencode --name "Lint pass" -- tidy the imports`);

  const child = await waitFor(
    async () => (await sessions(crew, main.id)).find((row) => row.kind === "child"),
    { timeout: 20_000, message: "the child reaches crewd" },
  );
  assert.equal(child.parentId, shell.id, "the session is its parent");
  assert.equal(child.name, "Lint pass");
  await waitFor(async () => (await sessions(crew, main.id)).find((row) => row.id === child.id)?.status === "idle", {
    timeout: 20_000,
    message: "its first turn ends",
  });

  // One line under the composer says so; there is no chip, no bar, no sidebar row.
  const work = crew.window.getByRole("button", { name: "1 finished", exact: true });
  await work.waitFor({ timeout: 10_000 });
  assert.equal(await crew.window.getByText("Sessions", { exact: true }).count(), 0, "no Sessions strip");
  assert.equal(await crew.window.getByText("Conversations", { exact: true }).count(), 0, "no Conversations in a bar");
  const rows = await crew.window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-session]")].map((row) => row.textContent ?? ""),
  );
  assert.ok(!rows.some((text) => text.includes("Lint pass")), JSON.stringify(rows));

  // The sheet lists it; opening it is the same tab, now showing its chat with its report.
  const tabs = crew.window.locator('[data-tab-strip] [role="tab"]');
  const before = await tabs.count();
  await work.click();
  const row = crew.window.locator("[data-work-sheet]").getByRole("option", { name: /Lint pass/ });
  await row.waitFor();
  await shots(crew, "status-line-sheet");
  await row.click();
  const thread = crew.window.locator("[data-agent-view]");
  await thread.getByText("Done: tidy the imports").waitFor({ timeout: 10_000 });
  await thread.getByText("Turn ended").waitFor({ timeout: 10_000 });
  assert.equal(await tabs.count(), before, "the tab count does not change");
  await shots(crew, "session-children");

  // Plan 2026-10-12 (decision 17): a subagent never has a tab. Esc goes back to the parent...
  const agentView = thread;
  await crew.window.keyboard.press("Escape");
  await agentView.waitFor({ state: "detached" });
  const childTab = `session:${child.id}`;
  assert.ok(!(await stripTabIds(crew)).includes(childTab), "opening it from the sheet made no tab");

  // ...a click on a banner about the child opens the parent's tab with the thread in it...
  await crew.app.evaluate(({ BrowserWindow }, target) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("notify:click", target);
  }, { workspaceId: main.id, sessionId: child.id });
  await agentView.waitFor({ timeout: 10_000 });
  await agentView.getByText("Done: tidy the imports").waitFor();
  assert.deepEqual((await stripTabIds(crew)).filter((id) => id.startsWith("session:")), [`session:${shell.id}`]);

  // ...and a layout saved with the child's tab restores as the parent's, thread open.
  await crew.request("state_set", {
    key: `tabs:${main.id}`,
    value: JSON.stringify({ tabs: [{ id: childTab, kind: "session", sessionId: child.id }], activeId: childTab }),
  });
  await crew.reload();
  await agentView.waitFor({ timeout: 15_000 });
  await agentView.getByText("Done: tidy the imports").waitFor();
  const ids = await stripTabIds(crew);
  assert.ok(!ids.includes(childTab), ids.join(", "));
  assert.ok(ids.includes(`session:${shell.id}`), ids.join(", "));
});
