// Pinned tabs keep to the strip's left end, their face alone. All together, a
// worktree's tabs fold into one chip from a tab's menu, and unfold from the
// chip or from anything that brings one of them on screen.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session } from "../src/lib/types.ts";
import {
  currentWorktree,
  goToWorktree,
  launchCrew,
  MOD,
  newTerminal,
  newWorktree,
  pressChord,
  stripTabIds,
  waitFor,
  worktreeHeader,
  WORKTREE_MOD,
  type Crew,
} from "./harness.ts";

const SHOTS = process.env.E2E_SHOTS;

async function shot(crew: Crew, name: string): Promise<void> {
  if (SHOTS) await crew.window.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function allTogether(crew: Crew): Promise<void> {
  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("combobox", { name: "Tabs" }).click();
  await page.getByRole("option", { name: "All together" }).click();
  await waitFor(async () => (await crew.request("state_get", { key: "tabs:scope" })) === "all", {
    message: "crewd stores the tab scope",
  });
  await pressChord(crew, `${MOD}+,`);
  await page.locator("[data-tab-strip]").waitFor({ state: "visible" });
}

function anyTab(crew: Crew, session: Session): Locator {
  return crew.window.locator(`[role="tab"][data-tab-id*="${session.id}"]`);
}

async function pick(crew: Crew, tab: Locator, action: string): Promise<void> {
  await tab.click({ button: "right" });
  await crew.window.getByRole("menuitem", { name: action }).click();
}

type Saved = { tabs: { id: string; pinned?: boolean }[]; activeId: string | null; collapsed?: string[] };

async function saved(crew: Crew, workspaceId: string): Promise<Saved | null> {
  const raw = await crew.request<string | null>("state_get", { key: `tabs:${workspaceId}` });
  return raw ? (JSON.parse(raw) as Saved) : null;
}

const has = (ids: string[], session: Session) => ids.some((id) => id.includes(session.id));

test("P1: a pinned tab keeps to the left, and a worktree's tabs fold into a chip and back", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  await allTogether(crew);
  await newWorktree(crew, "feat/alpha");
  await worktreeHeader(crew, "feat/alpha").and(currentWorktree(crew)).waitFor();
  const a1 = await newTerminal(crew, workspace.id);
  const a2 = await newTerminal(crew, workspace.id);
  await goToWorktree(crew, "main");
  const m1 = await newTerminal(crew, workspace.id);
  const m2 = await newTerminal(crew, workspace.id);
  await shot(crew, "1-start");

  // Pinned: out of the scrolling strip, first, and saved so.
  await pick(crew, anyTab(crew, m2), "Pin Tab");
  await crew.window.locator(`[data-tab-pins] [role="tab"][data-tab-id*="${m2.id}"]`).waitFor();
  assert.ok(!has(await stripTabIds(crew), m2), "the pinned tab leaves the strip");
  await waitFor(async () => (await saved(crew, workspace.id))?.tabs[0]?.pinned === true, {
    message: "crewd saves the pinned tab first",
  });
  assert.ok((await saved(crew, workspace.id))!.tabs[0]!.id.includes(m2.id));
  await shot(crew, "2-pinned");

  // Folding feat/alpha from one of its tabs: one chip, its tabs gone from the strip.
  await anyTab(crew, m1).click();
  await pick(crew, anyTab(crew, a2), "Collapse Worktree Tabs");
  const chip = crew.window.getByRole("button", { name: /^alpha, 2 tabs, collapsed$/ });
  await chip.waitFor();
  const strip = await stripTabIds(crew);
  assert.ok(!has(strip, a1) && !has(strip, a2), `feat/alpha's tabs fold away: ${JSON.stringify(strip)}`);
  await waitFor(async () => ((await saved(crew, workspace.id))?.collapsed?.length ?? 0) === 1, {
    message: "crewd saves the fold",
  });
  await shot(crew, "3-collapsed");

  // It survives a restart.
  crew = await crew.restart();
  await crew.window.getByRole("button", { name: /^alpha, 2 tabs, collapsed$/ }).waitFor();
  await crew.window.locator(`[data-tab-pins] [role="tab"][data-tab-id*="${m2.id}"]`).waitFor();

  // The chip unfolds them, side by side.
  await crew.window.getByRole("button", { name: /^alpha, 2 tabs, collapsed$/ }).click();
  await waitFor(async () => {
    const ids = await stripTabIds(crew);
    return has(ids, a1) && has(ids, a2);
  }, { message: "the chip unfolds feat/alpha's tabs" });
  const ids = await stripTabIds(crew);
  assert.equal(
    Math.abs(ids.findIndex((id) => id.includes(a1.id)) - ids.findIndex((id) => id.includes(a2.id))),
    1,
    "they unfold side by side",
  );
  await shot(crew, "4-expanded");

  // Folded again, going to its worktree brings its last used tab on screen, unfolded.
  await anyTab(crew, m1).click();
  await pick(crew, anyTab(crew, a1), "Collapse Worktree Tabs");
  await crew.window.getByRole("button", { name: /^alpha, 2 tabs, collapsed$/ }).waitFor();
  await pressChord(crew, `${WORKTREE_MOD}+2`);
  await crew.window.locator('[role="tab"][aria-selected="true"]').and(
    crew.window.locator(`[data-tab-id*="${a1.id}"], [data-tab-id*="${a2.id}"]`),
  ).waitFor();
  assert.equal(await crew.window.getByRole("button", { name: /collapsed$/ }).count(), 0);

  // Unpinned, it heads the unpinned tabs.
  await pick(crew, anyTab(crew, m2), "Unpin Tab");
  await waitFor(async () => (await stripTabIds(crew))[0]?.includes(m2.id) ?? false, {
    message: "the unpinned tab heads the strip",
  });
  assert.equal(await crew.window.locator("[data-tab-pins]").count(), 0);
});
