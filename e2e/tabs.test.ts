// L2: the tab launcher and the strip's order. Pages visited in a Crew browser
// tab (a local server, the only web the sandbox has) land in crewd's history;
// the launcher (⌘T) offers them under "Pages" by their title, and an address
// typed there opens as "Open <address>". Each pick loads the page, as the
// server sees. Dragging a tab along the strip reorders crewd's saved strip,
// and a relaunch paints the strip in that order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry } from "../src/lib/protocol.ts";
import {
  launchCrew,
  savedStrip,
  servePages,
  stripTabIds,
  waitFor,
  type Crew,
  type PageServer,
} from "./harness.ts";

/** The launcher, opened from the strip's plus (a page may hold the keyboard). */
async function openLauncher(crew: Crew) {
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const search = crew.window.getByRole("textbox", { name: "Open a tab" });
  await search.waitFor();
  return search;
}

/** The launcher's rows as [group heading, label], in order; ungrouped rows head with "". */
async function launcherRows(crew: Crew): Promise<[string, string][]> {
  const search = crew.window.getByRole("textbox", { name: "Open a tab" });
  const list = search.locator("xpath=following-sibling::div[1]");
  return list.evaluate((element) => {
    const rows: [string, string][] = [];
    let heading = "";
    for (const child of element.children) {
      if (child instanceof HTMLButtonElement) {
        rows.push([heading, child.querySelector(".truncate")?.textContent?.trim() ?? ""]);
      } else {
        heading = child.textContent?.trim() ?? "";
      }
    }
    return rows;
  });
}

/** How many times the server was asked for `path`. */
const hits = (server: PageServer, path: string) => server.requests.filter((at) => at === path).length;

/** crewd's history of `url`, once it has the page's title. */
async function visited(crew: Crew, url: string, title: string): Promise<HistoryEntry> {
  return waitFor(
    async () => {
      const entries = await crew.request<HistoryEntry[]>("browser_history_list", { limit: 50 });
      return entries.find((entry) => entry.url === url && entry.title === title);
    },
    { message: `crewd's history has ${url} titled "${title}"` },
  );
}

test("L2: visited pages and typed addresses open from the launcher; a dragged strip keeps its order", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const titles = { "/alpha": "Alpha harbor", "/beta": "Beta lighthouse", "/gamma": "Gamma quarry" };
  const server = await servePages(titles);
  t.after(() => server.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const url = (at: keyof typeof titles) => `${server.origin}${at}`;

  // Two pages, each opened by typing its address into the launcher: "Open <address>".
  const openAddress = async (at: keyof typeof titles) => {
    const search = await openLauncher(crew);
    const typed = url(at).replace(/^http:\/\//, "");
    await search.fill(typed);
    await page.getByRole("button", { name: `Open ${typed}`, exact: true }).click();
    await waitFor(() => hits(server, at) >= 1, { message: `a new tab loads ${at}` });
  };
  for (const at of ["/alpha", "/beta"] as const) {
    await openAddress(at);
    await visited(crew, url(at), titles[at]);
  }
  assert.equal((await stripTabIds(crew)).length, 2, "each address opened a page of its own");

  // A piece of the second page's title finds it under Pages.
  const search = await openLauncher(crew);
  await search.fill("lighthouse");
  await waitFor(
    async () => (await launcherRows(crew)).some(([group, label]) => group === "Pages" && label === titles["/beta"]),
    { message: `the launcher lists "${titles["/beta"]}" under Pages` },
  );
  assert.ok(
    !(await launcherRows(crew)).some(([, label]) => label === titles["/alpha"]),
    "the other page does not match the query",
  );
  await page.getByRole("button", { name: titles["/beta"] }).click();
  await waitFor(() => hits(server, "/beta") === 2, { message: "the picked page loads again, in a tab of its own" });

  // An address nobody visited opens the same way.
  await openAddress("/gamma");
  assert.equal(hits(server, "/gamma"), 1);

  const before = await waitFor(async () => {
    const ids = await stripTabIds(crew);
    return ids.length === 4 && ids;
  }, { message: "four pages on the strip" });
  await waitFor(
    async () => {
      const saved = await savedStrip(crew, workspace.id);
      return saved && JSON.stringify(saved.ids) === JSON.stringify(before);
    },
    { message: "crewd saved the strip as it shows" },
  );

  // The last tab dragged to the front: past the sortable's 5px, in steps.
  const [first, second, third, fourth] = before as [string, string, string, string];
  const tab = (id: string) => page.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);
  const from = await tab(fourth).boundingBox();
  const to = await tab(first).boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 8, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
  const dragged = [fourth, first, second, third];
  await waitFor(
    async () => JSON.stringify((await savedStrip(crew, workspace.id))?.ids) === JSON.stringify(dragged),
    { message: "crewd saves the dragged order" },
  );

  crew = await crew.restart();
  const shown = await waitFor(async () => {
    const ids = await stripTabIds(crew);
    return ids.length === 4 && ids;
  }, { message: "the relaunched strip paints its four pages" });
  assert.deepEqual(shown, dragged, "the relaunched strip is in the dragged order");
});
