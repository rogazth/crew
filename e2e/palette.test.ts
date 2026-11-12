// ⌘K, the one door: it opens on Chats with a screen of suggestions and no
// scroll, finds a session by what was said in it and opens it there, steps
// through its tabs with ⇥, and closes with its X. Files and Commands have no
// chord of their own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLine, composerOf, launchCrew, MOD, newSession, pressChord, sendInChat, storedStatus, waitFor, type Crew } from "./harness.ts";
import type { Session } from "../src/lib/types.ts";

const palette = (crew: Crew) => crew.window.getByRole("dialog", { name: "Command palette" });

async function said(crew: Crew, session: Session, text: string): Promise<void> {
  await sendInChat(crew, text);
  await chatLine(crew, `Reply 1: ${text}`).waitFor();
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: `${session.name} is idle again` });
}

test("K1: ⌘K suggests a screen of chats, finds a line said in one and opens it there, and closes with its X", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const walrus = await newSession(crew, workspace.id);
  await said(crew, walrus, "the walrus keeps the ledger");
  const other = await newSession(crew, workspace.id);
  await said(crew, other, "hello");

  // Before anything is typed: Chats, the one on screen left out, nothing to scroll.
  await pressChord(crew, `${MOD}+k`);
  const dialog = palette(crew);
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("tab", { name: "Chats" }).getAttribute("aria-selected"), "true");
  await dialog.locator("button[data-index]").first().waitFor();
  const list = await dialog.evaluate((el) => {
    const scroller = el.querySelector<HTMLElement>(".overflow-y-auto")!;
    return { rows: scroller.querySelectorAll("[data-index]").length, fits: scroller.scrollHeight <= scroller.clientHeight };
  });
  assert.ok(list.rows >= 1 && list.rows <= 6, `${list.rows} suggestions`);
  assert.ok(list.fits, "the suggestions fit without a scroll");
  assert.equal(await dialog.getByText("esc", { exact: true }).count(), 0, "no esc hint: a real close button");

  // What was said: the line, marked, in the one list names and lines share; it opens that session.
  await dialog.getByRole("textbox", { name: "Search" }).fill("walrus");
  const hit = dialog.locator("button[data-index]").filter({ has: crew.window.locator("mark", { hasText: /walrus/i }) }).first();
  await hit.waitFor();
  assert.equal(await dialog.locator("[data-group-header]").count(), 0, "names and lines are one list");
  await hit.click();
  await dialog.waitFor({ state: "detached" });
  await composerOf(crew, walrus).waitFor();
  await chatLine(crew, "the walrus keeps the ledger").waitFor();

  // ⇥ steps through the tabs; the X closes it.
  await pressChord(crew, `${MOD}+k`);
  await dialog.waitFor();
  for (const tab of ["Files", "Workspaces", "Commands", "Chats"]) {
    await crew.window.keyboard.press("Tab");
    await waitFor(async () => (await dialog.getByRole("tab", { name: tab }).getAttribute("aria-selected")) === "true", {
      message: `⇥ reaches ${tab}`,
    });
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
});
