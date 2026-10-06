// A claude terminal whose turn ends on work it left in the background (a build
// run with `run_in_background`): Claude ends the turn, rests its title, and is
// woken by the build's notification once it ends. Until then the turn is over
// but the session is not: its row reads Running in background, never a reply
// to read that only said it is waiting.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { holdsFor, launchCrew, lightIn, newTerminal, sessionRow, sessionTab, storedStatus, typeInTerminal, waitFor, type Crew } from "./harness.ts";

async function reads(crew: Crew, session: Session, label: string, status: Session["status"]): Promise<boolean | string> {
  const [light, stored] = await Promise.all([lightIn(sessionRow(crew, session.name)), storedStatus(crew, session.id)]);
  return (light === label && stored === status) || `row reads ${light}, crewd stores ${stored}`;
}

test("a turn that ends on a build left running reads Running in background until the build reports back and the next turn ends", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);

  const other = await newTerminal(crew, workspace.id);
  const s = await newTerminal(crew, workspace.id);
  // Out of sight when it runs, so a finished turn would read Unread.
  await typeInTerminal(crew, "after 1 background 6");
  await sessionTab(crew, other).click();
  // The turn ends a moment in, on the build; the build runs about six seconds.
  await waitFor(async () => (await reads(crew, s, "Running in background", "background")) === true, {
    message: "the turn ends on the build",
    timeout: 10_000,
  });
  await holdsFor(3_000, () => reads(crew, s, "Running in background", "background"), "the session stopped reading Running in background while its build ran");

  // The build's notification starts a turn, and that one ends with nothing left running.
  await waitFor(async () => (await reads(crew, s, "Unread", "done")) === true, {
    message: "the session reads Unread once the turn the build woke ends",
    timeout: 10_000,
  });
});
