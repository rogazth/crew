// A claude terminal whose turn ends on work it left in the background (a build
// run with `run_in_background`): Claude ends the turn, rests its title, and is
// woken by the build's notification once it ends. Until then the session is at
// work, not done: its row must not flag a reply that only said it is waiting.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { holdsFor, launchCrew, lightIn, newTerminal, sessionRow, sessionTab, storedStatus, typeInTerminal, waitFor, type Crew } from "./harness.ts";

async function reads(crew: Crew, session: Session, label: string, status: Session["status"]): Promise<boolean | string> {
  const [light, stored] = await Promise.all([lightIn(sessionRow(crew, session.name)), storedStatus(crew, session.id)]);
  return (light === label && stored === status) || `row reads ${light}, crewd stores ${stored}`;
}

test("a turn that ends on a build left running reads Working until the build reports back and the next turn ends", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const other = await newTerminal(crew, workspace.id);
  const s = await newTerminal(crew, workspace.id);
  // Out of sight when it runs, so a finished turn would read Unread.
  await typeInTerminal(crew, "after 1 background 6");
  await sessionTab(crew, other).click();
  await waitFor(async () => (await reads(crew, s, "Working", "working")) === true, { message: "the turn starts", timeout: 10_000 });

  // The turn ended a moment in, on the build; the build runs about six seconds.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await holdsFor(3_500, () => reads(crew, s, "Working", "working"), "the session stopped reading Working while its build ran");

  // The build's notification starts a turn, and that one ends with nothing left running.
  await waitFor(async () => (await reads(crew, s, "Unread", "done")) === true, {
    message: "the session reads Unread once the turn the build woke ends",
    timeout: 10_000,
  });
});
