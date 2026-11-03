// A page that aborts the app is saved as the active tab, so every launch would
// die on it again. After a run that died before it settled, saved pages stay
// cold until they are opened. The crash is the process killed, as a CHECK in
// Chromium kills it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchCrew, savedStrip, servePages, stripTabIds, waitFor, webviewIn, type Crew } from "./harness.ts";

async function openPage(crew: Crew, url: string): Promise<string> {
  const before = await stripTabIds(crew);
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  await crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab")).first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before.length, { message: "a browser tab opens" });
  const id = (await stripTabIds(crew)).find((tab) => !before.includes(tab))!;
  await waitFor(async () => (await savedStrip(crew, crew.workspaces[0]!.id))?.activeId === id, { message: "the tab is saved as active" });
  return id;
}

const liveGuests = (crew: Crew) =>
  crew.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getType() === "webview").length);

test("a launch after a crash leaves saved pages cold until they are opened", async () => {
  const site = await servePages({ "/page": "The page" });
  let crew = await launchCrew();
  try {
    const url = `${site.origin}/page`;
    const tab = await openPage(crew, url);
    await waitFor(() => site.requests.includes("/page"), { message: "the page loads" });

    // A clean quit is no crash: the page comes back on screen.
    crew = await crew.restart();
    await waitFor(async () => (await liveGuests(crew)) === 1, { message: "the active page is live after a clean quit" });
    assert.equal((await savedStrip(crew, crew.workspaces[0]!.id))?.activeId, tab);

    // The app dies while it starts.
    process.kill(crew.app.process().pid!, "SIGTRAP");
    site.requests.length = 0;
    crew = await crew.restart();

    await waitFor(async () => (await stripTabIds(crew)).includes(tab), { message: "the tab is still in the strip" });
    await waitFor(async () => (await savedStrip(crew, crew.workspaces[0]!.id))?.activeId !== tab, { message: "it no longer opens by itself" });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(await liveGuests(crew), 0, "no guest was built");
    assert.deepEqual(site.requests, [], "the page was not requested");

    // Opened on purpose, it works as ever.
    await crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${tab}"]`).click();
    await webviewIn(crew.window).first().waitFor({ state: "attached" });
    await waitFor(() => site.requests.includes("/page"), { message: "the page loads once opened" });

    // This run quit cleanly, so the next one is normal.
    crew = await crew.restart();
    await waitFor(async () => (await liveGuests(crew)) === 1, { message: "the page is live on the next launch" });
  } finally {
    await crew.close();
    await site.close();
  }
});
