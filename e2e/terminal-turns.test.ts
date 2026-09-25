// T1 and T3: what a claude terminal's row says through a turn, read against
// what crewd stores and what the CLI actually did (its transcript, the hook
// records it left). The fake claude spins its title while a turn runs, as the
// real one does; the window only sees the terminal.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import {
  holdsFor,
  launchCrew,
  lightIn,
  newTerminal,
  sessionRow,
  sessionTab,
  storedStatus,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

/** The records the CLI wrote for a session, as Claude keeps them under its cwd. */
async function transcript(crew: Crew, cwd: string, id: string): Promise<{ type: string }[]> {
  const file = path.join(crew.home, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

/** The row and crewd agree on a status: the row's light reads `label`, crewd stores `status`. */
async function reads(crew: Crew, session: Session, label: string, status: Session["status"]): Promise<boolean | string> {
  const [light, stored] = await Promise.all([lightIn(sessionRow(crew, session.name)), storedStatus(crew, session.id)]);
  return (light === label && stored === status) || `row reads ${light}, crewd stores ${stored}`;
}

async function becomes(crew: Crew, session: Session, label: string, status: Session["status"], timeout = 10_000) {
  let last: boolean | string = false;
  const ok = await waitFor(
    async () => {
      last = await reads(crew, session, label, status);
      return last === true;
    },
    { timeout },
  ).catch(() => false);
  assert.ok(ok, `${session.name} should read ${label} (crewd: ${status}); ${String(last)}`);
}

test("T1: a long turn reads Working across tab switches, Unread when it ends out of sight, its row marks it read, and read stays read", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const s1 = await newTerminal(crew, workspace.id);
  // The CLI drawing its first screen is not a turn: nothing was asked of it.
  await holdsFor(
    3000,
    async () => {
      const light = await lightIn(sessionRow(crew, s1.name));
      const stored = await storedStatus(crew, s1.id);
      return (light !== "Working" && stored !== "working") || `row reads ${light}, crewd stores ${stored}`;
    },
    "the first screen counts as a turn",
  );
  const s2 = await newTerminal(crew, workspace.id);

  await sessionTab(crew, s1).click();
  await typeInTerminal(crew, "work 8");
  await becomes(crew, s1, "Working", "working", 5000);

  // Away, back, away again, all mid-turn: it keeps reading Working throughout.
  for (const tab of [s2, s1, s2]) {
    await sessionTab(crew, tab).click();
    await holdsFor(1000, () => reads(crew, s1, "Working", "working"), `with ${tab.name} on screen, ${s1.name} stops reading Working`);
  }
  assert.ok(
    !(await transcript(crew, workspace.path, s1.id)).some((record) => record.type === "assistant"),
    "the checks above ran while the turn was still going",
  );

  // It ends while s2 is on screen: Unread, once the CLI really wrote its answer.
  await becomes(crew, s1, "Unread", "done", 15_000);
  assert.ok(
    (await transcript(crew, workspace.path, s1.id)).some((record) => record.type === "assistant"),
    "Unread only once the CLI finished the turn",
  );

  // The row's menu reads it, with s2 still on screen: the tab never showed it (Q1).
  const page = crew.window;
  // force: dnd-kit marks the sortable wrapper aria-disabled while dragging is
  // off, which Playwright takes for a disabled button; the mouse press is real.
  await sessionRow(crew, s1.name).click({ button: "right", force: true });
  await page.getByRole("menu").getByRole("menuitem", { name: "Mark as Read" }).click();
  await page.getByRole("menu").waitFor({ state: "detached" });
  await becomes(crew, s1, "Idle", "idle", 5000);
  assert.equal(await sessionTab(crew, s2).getAttribute("aria-selected"), "true", "s2 stayed on screen");

  // Read stays read across a restart, with s1 out of sight so nothing reads it again.
  await sessionTab(crew, s2).and(crew.window.locator('[aria-selected="true"]')).waitFor();
  crew = await crew.restart();
  await sessionRow(crew, s1.name).waitFor();
  await holdsFor(3000, () => reads(crew, s1, "Idle", "idle"), `${s1.name} comes back unread`);
});

test("T3: a permission prompt out of sight reads Needs input; answering it works, then rests", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const s1 = await newTerminal(crew, workspace.id);
  const s2 = await newTerminal(crew, workspace.id);
  await sessionTab(crew, s1).click();
  // The CLI asks two seconds from now, by which time s2 is on screen.
  await typeInTerminal(crew, "after 2 ask");
  await sessionTab(crew, s2).click();

  await becomes(crew, s1, "Needs input", "needs-input");
  // The question went through Claude's Notification hook, and crewd took the record.
  const attention = path.join(crew.userData, "claude-bind", `${s1.id}.attention`);
  assert.ok(!existsSync(attention), "crewd consumed the hook's attention record");
  await holdsFor(2000, () => reads(crew, s1, "Needs input", "needs-input"), `${s1.name} stops waiting on its own`);

  // Back to it and answer: the CLI runs the tool, then rests.
  await sessionTab(crew, s1).click();
  const before = (await transcript(crew, workspace.path, s1.id)).filter((record) => record.type === "assistant").length;
  await typeInTerminal(crew, "1");
  await becomes(crew, s1, "Working", "working", 3000);
  await becomes(crew, s1, "Idle", "idle");
  const after = (await transcript(crew, workspace.path, s1.id)).filter((record) => record.type === "assistant").length;
  assert.equal(after, before + 1, "the answered prompt ran one turn to its end");
  await holdsFor(2000, () => reads(crew, s1, "Idle", "idle"), `${s1.name} does not go back to asking`);
});
