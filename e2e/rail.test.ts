// R1 and R2: the workspace rail. Switching, reordering, renaming and removing
// workspaces, read back from crewd and across a restart; and a workspace out
// of sight telling through its mark what its claude terminal is doing, in
// agreement with what crewd stores for that session.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import type { Session, Workspace } from "../src/lib/types.ts";
import {
  launchCrew,
  lightIn,
  MOD,
  newTerminal,
  pressChord,
  sessionRow,
  sessions,
  storedStatus,
  typeInTerminal,
  waitFor,
  type Crew,
} from "./harness.ts";

function rail(crew: Crew): Locator {
  return crew.window.locator('nav[aria-label="Workspaces"][data-sidebar-rail] [data-rail-marks]');
}

function mark(crew: Crew, name: string): Locator {
  // The button itself: dnd-kit's sortable wrapper around it is a role=button too.
  return rail(crew).locator(`button[data-nav][aria-label="${name}"]`);
}

/** The marks' labels, top to bottom. */
function railNames(crew: Crew): Promise<string[]> {
  return rail(crew)
    .locator("button[data-nav]")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
}

async function listed(crew: Crew): Promise<Workspace[]> {
  return crew.request<Workspace[]>("workspace_list");
}

/** The session rows the panel beside the rail shows. */
function panelRows(crew: Crew): Promise<string[]> {
  return crew.window
    .locator("[data-sidebar-panel] button[data-session]")
    .evaluateAll((rows) => rows.map((row) => (row.getAttribute("title") ?? "").split(" — ")[0] ?? ""));
}

/** crewd has `workspace` active, and the panel lists exactly its sessions. */
async function onScreen(crew: Crew, workspace: Workspace, expected: string[]): Promise<void> {
  let last: unknown = null;
  const ok = await waitFor(
    async () => {
      const active = await crew.request<string | null>("active_workspace_get");
      const rows = await panelRows(crew);
      last = { active, rows };
      return active === workspace.id && JSON.stringify(rows) === JSON.stringify(expected);
    },
    { timeout: 5000 },
  ).catch(() => false);
  assert.ok(ok, `${workspace.name} should be on screen with ${JSON.stringify(expected)}; got ${JSON.stringify(last)}`);
}

async function sameOrder(crew: Crew, ids: string[], message: string): Promise<void> {
  let last: string[] = [];
  const ok = await waitFor(
    async () => {
      last = (await listed(crew)).map((workspace) => workspace.id);
      return JSON.stringify(last) === JSON.stringify(ids);
    },
    { timeout: 5000 },
  ).catch(() => false);
  if (!ok) assert.deepEqual(last, ids, message);
}

test("R1: the rail switches, reorders, renames and removes workspaces, and crewd keeps it across a restart", async (t) => {
  let crew = await launchCrew({ repos: ["alpha", "beta", "gamma"] });
  t.after(() => crew.close());
  const [alpha, beta, gamma] = crew.workspaces;
  assert.ok(alpha && beta && gamma);
  const page = () => crew.window;

  // A session in each, made in crewd, with names the startup sweep keeps.
  const notes = new Map<string, string>();
  for (const workspace of crew.workspaces) {
    const name = `${workspace.name} notes`;
    await crew.request<Session>("session_create", {
      workspaceId: workspace.id,
      kind: "terminal",
      name,
      provider: "claude",
      model: "",
      description: "",
      autonomy: "full",
    });
    notes.set(workspace.id, name);
  }
  await crew.reload();
  const shows = (workspace: Workspace) => onScreen(crew, workspace, [notes.get(workspace.id)!]);
  await shows(alpha);

  // ⌘3, ⌘1, ⌘2 (Ctrl off macOS); the last from a workspace with a terminal open,
  // pressed the way pressChord does, out of the terminal.
  await pressChord(crew, `${MOD}+3`);
  await shows(gamma);
  await pressChord(crew, `${MOD}+1`);
  await shows(alpha);
  await newTerminal(crew, alpha.id);
  await pressChord(crew, `${MOD}+2`);
  await shows(beta);

  // gamma dragged to the top. The sortable starts past 5px; the steps get it there.
  const from = await mark(crew, "gamma").boundingBox();
  const to = await mark(crew, "alpha").boundingBox();
  assert.ok(from && to);
  await page().mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page().mouse.down();
  await page().mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8, { steps: 4 });
  await page().mouse.move(to.x + to.width / 2, to.y + 2, { steps: 20 });
  await page().mouse.up();
  await sameOrder(crew, [gamma.id, alpha.id, beta.id], "crewd stores the dragged order");
  // The drop animates a copy of the mark; the rail settles on the new order.
  await waitFor(async () => JSON.stringify(await railNames(crew)) === JSON.stringify(["gamma", "alpha", "beta"]), {
    timeout: 5000,
    message: "the rail settles on the dragged order",
  });
  // The digits follow the rail: ⌘1 is gamma now.
  await pressChord(crew, `${MOD}+1`);
  await shows(gamma);
  await pressChord(crew, `${MOD}+3`);
  await shows(beta);

  // Renamed from its mark's menu.
  await mark(crew, "beta").click({ button: "right" });
  const field = page().getByRole("menu").getByRole("textbox", { name: "Rename" });
  await field.fill("Backend");
  await field.press("Enter");
  await waitFor(async () => (await listed(crew)).find((workspace) => workspace.id === beta.id)?.name === "Backend", {
    timeout: 5000,
    message: "crewd renames beta",
  });

  // Order, name and the workspace on screen come back.
  crew = await crew.restart();
  await sameOrder(crew, [gamma.id, alpha.id, beta.id], "the order survives the restart");
  assert.equal((await listed(crew)).find((workspace) => workspace.id === beta.id)?.name, "Backend");
  assert.deepEqual(await railNames(crew), ["gamma", "alpha", "Backend"]);
  await shows(beta);

  // Removed from its mark's menu: gone from crewd with its sessions, its folder untouched.
  const head = await crew.git(alpha.path, "rev-parse", "HEAD");
  await mark(crew, "alpha").click({ button: "right" });
  await page().getByRole("menu").getByRole("menuitem", { name: "Remove Workspace…" }).click();
  const alert = page().getByRole("alertdialog");
  await alert.getByText('Remove workspace "alpha"?').waitFor();
  await alert.getByRole("button", { name: "Remove" }).click();
  await alert.waitFor({ state: "detached" });
  await sameOrder(crew, [gamma.id, beta.id], "crewd no longer lists alpha");
  assert.deepEqual(await sessions(crew, alpha.id), [], "alpha's sessions went with it");
  assert.deepEqual(await railNames(crew), ["gamma", "Backend"]);
  await shows(beta);
  assert.equal(await readFile(path.join(alpha.path, "README.md"), "utf8"), "# alpha\n");
  assert.equal(await crew.git(alpha.path, "rev-parse", "HEAD"), head);
  assert.equal(await crew.git(alpha.path, "status", "--porcelain"), "", "nothing in the folder changed");
});

test("R2: a workspace out of sight shows on its mark what its claude terminal did", async (t) => {
  const crew = await launchCrew({ repos: ["front", "back"] });
  t.after(() => crew.close());
  const [front, back] = crew.workspaces;
  assert.ok(front && back);

  /** back's mark and crewd agree on its session: the mark's light reads `label`, crewd stores `status`. */
  const agree = async (session: Session, label: string, status: Session["status"], timeout = 10_000) => {
    let last = "";
    const ok = await waitFor(
      async () => {
        const [light, stored, active] = await Promise.all([
          lightIn(mark(crew, "back")),
          storedStatus(crew, session.id),
          crew.request<string | null>("active_workspace_get"),
        ]);
        last = `mark reads ${light}, crewd stores ${stored}, ${active === front.id ? "front" : "back"} on screen`;
        return light === label && stored === status && active === front.id;
      },
      { timeout },
    ).catch(() => false);
    assert.ok(ok, `back's mark should read ${label} (crewd: ${status}) with front on screen; ${last}`);
  };

  await pressChord(crew, `${MOD}+2`);
  const session = await newTerminal(crew, back.id);
  await typeInTerminal(crew, "work 4");
  await waitFor(async () => (await storedStatus(crew, session.id)) === "working", { message: "the turn starts" });
  await pressChord(crew, `${MOD}+1`);
  await sessionRow(crew, session.name).waitFor({ state: "detached" });

  await agree(session, "Working", "working", 3000);
  // The turn ends out of sight: the mark says there is something unread in back.
  await agree(session, "Unread", "done");

  // Looking at back reads it; then its CLI asks for a permission after the window left.
  await pressChord(crew, `${MOD}+2`);
  await waitFor(async () => (await storedStatus(crew, session.id)) === "idle", { message: "looking at back reads it" });
  await typeInTerminal(crew, "after 2 ask");
  await pressChord(crew, `${MOD}+1`);
  await agree(session, "Needs input", "needs-input");
});
