// Opening a session again repaints its CLI: a CLI that ran on with its tab
// closed is replayed from crewd's ring, last turn's spinning title included,
// and a stopped one resumes and redraws the conversation it loaded. That is
// the session coming back, not news: it must not ring as a finished turn,
// even with its tab out of sight by the time the repaint settles.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { holdsFor, launchCrew, newTerminal, sessionRow, sessionTab, storedStatus, typeInTerminal, waitFor, type Crew } from "./harness.ts";

type Banner = { title: string; body: string };

/** Takes over the banner channel: what the window asks to show is kept, not shown. */
async function recordBanners(crew: Crew): Promise<() => Promise<Banner[]>> {
  await crew.app.evaluate(({ ipcMain }) => {
    const shown: Banner[] = [];
    (globalThis as { banners?: Banner[] }).banners = shown;
    ipcMain.removeHandler("notify");
    ipcMain.handle("notify", (_event, banner: Banner) => {
      shown.push({ title: banner.title, body: banner.body });
      return "shown";
    });
  });
  return () => crew.app.evaluate(() => [...((globalThis as { banners?: Banner[] }).banners ?? [])]);
}

/** Toasts saying a turn finished: in front, the window says it instead of a banner. */
function finished(crew: Crew): Promise<number> {
  return crew.window.getByText("Finished", { exact: true }).count();
}

async function rowOf(crew: Crew, session: Session) {
  const row = await crew.request<Session | null>("session_get", { id: session.id });
  return sessionRow(crew, row?.name ?? session.name);
}

async function closeTab(crew: Crew, session: Session) {
  const tab = sessionTab(crew, session);
  await tab.getByRole("button", { name: "Close tab" }).click();
  await tab.waitFor({ state: "detached" });
}

for (const stopped of [false, true]) {
  test(`a session opened again ${stopped ? "resumes" : "attaches"} quietly, its tab left before the CLI settles`, async (t) => {
    const crew = await launchCrew();
    t.after(() => crew.close());
    const [workspace] = crew.workspaces;
    assert.ok(workspace);

    const s1 = await newTerminal(crew, workspace.id);
    await typeInTerminal(crew, "hello");
    await waitFor(async () => (await storedStatus(crew, s1.id)) === "working", { message: "the turn starts" });
    await waitFor(async () => (await storedStatus(crew, s1.id)) === "idle", { message: "the turn ends" });
    const s2 = await newTerminal(crew, workspace.id);

    // Its tab closes and the CLI runs on, or is stopped and resumes when opened.
    await closeTab(crew, s1);
    const launches = (await crew.claudeLaunches()).length;
    if (stopped) {
      await (await rowOf(crew, s1)).click({ button: "right", force: true });
      await crew.window.getByRole("menu").getByRole("menuitem", { name: "Stop" }).click();
    }

    const banners = await recordBanners(crew);
    await (await rowOf(crew, s1)).click({ force: true });
    await sessionTab(crew, s1).waitFor();
    if (stopped) await waitFor(async () => (await crew.claudeLaunches()).length > launches, { message: "opening it resumes the CLI" });
    // The ring's replay is under way.
    else await crew.window.waitForTimeout(300);
    // Away before the CLI is done repainting.
    await sessionTab(crew, s2).click();

    await holdsFor(
      5000,
      async () => {
        const seen = await banners();
        const toasts = await finished(crew);
        return (seen.length === 0 && toasts === 0) || `rang: ${JSON.stringify(seen)}, ${toasts} toasts`;
      },
      "opening the session rang as news",
    );
    assert.notEqual(await storedStatus(crew, s1.id), "done", "opening it left an unread reply");

    // A turn that really ends out of sight is still news.
    await sessionTab(crew, s1).click();
    await typeInTerminal(crew, "after 1 hello");
    await sessionTab(crew, s2).click();
    await waitFor(async () => (await storedStatus(crew, s1.id)) === "done", { message: "the next turn ends unread" });
    await waitFor(async () => (await banners()).length + (await finished(crew)) > 0, { message: "the next turn rings" });
  });
}
