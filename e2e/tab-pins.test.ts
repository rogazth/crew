// Pinned tabs keep to the strip's left end, their face alone, and come back
// there after a restart.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, newSession, stripTabIds, waitFor, type Crew } from "./harness.ts";

function anyTab(crew: Crew, session: Session): Locator {
  return crew.window.locator(`[role="tab"][data-tab-id*="${session.id}"]`);
}

async function pick(crew: Crew, tab: Locator, action: string): Promise<void> {
  await tab.click({ button: "right" });
  await crew.window.getByRole("menuitem", { name: action }).click();
}

type Saved = { tabs: { id: string; pinned?: boolean }[]; activeId: string | null };

async function saved(crew: Crew, workspaceId: string): Promise<Saved | null> {
  const raw = await crew.request<string | null>("state_get", { key: `tabs:${workspaceId}` });
  return raw ? (JSON.parse(raw) as Saved) : null;
}

const has = (ids: string[], session: Session) => ids.some((id) => id.includes(session.id));

test("P1: a pinned tab keeps to the left, survives a restart, and unpinned heads the other tabs", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const m1 = await newSession(crew, workspace.id);
  const m2 = await newSession(crew, workspace.id);
  await newSession(crew, workspace.id);

  // Pinned: out of the scrolling strip, first, and saved so.
  await pick(crew, anyTab(crew, m2), "Pin tab");
  await crew.window.locator(`[data-tab-pins] [role="tab"][data-tab-id*="${m2.id}"]`).waitFor();
  assert.ok(!has(await stripTabIds(crew), m2), "the pinned tab leaves the strip");
  await waitFor(async () => (await saved(crew, workspace.id))?.tabs[0]?.pinned === true, {
    message: "crewd saves the pinned tab first",
  });
  assert.ok((await saved(crew, workspace.id))!.tabs[0]!.id.includes(m2.id));

  // It survives a restart.
  crew = await crew.restart();
  await crew.window.locator(`[data-tab-pins] [role="tab"][data-tab-id*="${m2.id}"]`).waitFor();
  assert.ok(has(await stripTabIds(crew), m1), "the unpinned tabs stay in the strip");

  // Unpinned, it heads the unpinned tabs.
  await pick(crew, anyTab(crew, m2), "Unpin tab");
  await waitFor(async () => (await stripTabIds(crew))[0]?.includes(m2.id) ?? false, {
    message: "the unpinned tab heads the strip",
  });
  assert.equal(await crew.window.locator("[data-tab-pins]").count(), 0);
});
