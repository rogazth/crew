// Plan 2026-10-05 (UI decision 1): a session started with start_session lives
// in whoever started it — a chip in its parent's bar, not a sidebar row — and
// opens as Crew's chat. The session's CLI starts it
// from its own shell with `crew sessions delegate`, with the session's token, so
// the parent is the session; the fake opencode 2.x (e2e/bin/opencode) answers.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "../src/lib/types.ts";
import { installFakeOpencode, launchCrew, newSession, sendInChat, stripTabIds, waitFor, type Crew } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CREW = path.join(ROOT, "target/debug/crew");

const sessions = (crew: Crew, workspaceId: string) => crew.request<Session[]>("session_list", { workspaceId });

test("a session a session started is a chip in its parent and opens as a chat", async (t) => {
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

  // A chip in the parent's bar, and no row of its own in the sidebar.
  const chip = crew.window.getByRole("button", { name: /Lint pass/ }).first();
  await chip.waitFor({ timeout: 10_000 });
  const rows = await crew.window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-session]")].map((row) => row.textContent ?? ""),
  );
  assert.ok(!rows.some((text) => text.includes("Lint pass")), JSON.stringify(rows));

  // Its tab is the chat Crew drives it from, with its report in it.
  await chip.click();
  await crew.window.getByText("Done: tidy the imports").waitFor({ timeout: 10_000 });
  await crew.window.getByText("Turn ended").waitFor({ timeout: 10_000 });
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "session-children.png") });

  // Plan 2026-10-12 (decision 17): a subagent never has a tab. Esc goes back to the parent...
  const agentView = crew.window.locator("[data-agent-view]");
  await crew.window.keyboard.press("Escape");
  await agentView.waitFor({ state: "detached" });
  const childTab = `session:${child.id}`;
  assert.ok(!(await stripTabIds(crew)).includes(childTab), "opening it from the chip made no tab");

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
