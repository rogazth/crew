// L2: the blank tab and the strip's order. Pages visited in a Crew browser
// tab (a local server, the only web the sandbox has) land in crewd's history;
// the blank tab (⌘T, or the plus) offers them by their title, and an address
// typed there opens as "Open <address>". Each pick loads the page, as the
// server sees, in the blank tab's seat. Dragging a tab along the strip
// reorders crewd's saved strip, and a relaunch paints the strip in that order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry } from "../src/lib/protocol.ts";
import {
  launchCrew,
  openAddress,
  savedStrip,
  servePages,
  stripTabIds,
  waitFor,
  type Crew,
  type PageServer,
} from "./harness.ts";

/** A blank tab, opened from the strip's plus (a page may hold the keyboard). */
async function openNewTab(crew: Crew) {
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const search = crew.window.locator("input[aria-label='Open a tab']:visible");
  await search.waitFor();
  return search;
}

/** The blank tab's rows on screen, each as its text: its title, then the line under it. */
async function rowTexts(crew: Crew): Promise<string[]> {
  return crew.window.getByRole("option").evaluateAll((rows) => rows.map((row) => row.textContent?.trim() ?? ""));
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

test("L2: visited pages and typed addresses open from a blank tab; a dragged strip keeps its order", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const titles = { "/alpha": "Alpha harbor", "/beta": "Beta lighthouse", "/gamma": "Gamma quarry" };
  const server = await servePages(titles);
  t.after(() => server.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;
  const url = (at: keyof typeof titles) => `${server.origin}${at}`;

  // Two pages, each opened by typing its address into a blank tab: "Open <host>" leads, and ↵ opens it.
  const openPage = async (at: keyof typeof titles) => {
    await openAddress(crew, url(at).replace(/^http:\/\//, ""));
    await waitFor(() => hits(server, at) >= 1, { message: `a new tab loads ${at}` });
  };
  for (const at of ["/alpha", "/beta"] as const) {
    await openPage(at);
    await visited(crew, url(at), titles[at]);
  }
  assert.equal((await stripTabIds(crew)).length, 2, "each address opened a page of its own");

  // A piece of the second page's title finds it.
  const search = await openNewTab(crew);
  await search.fill("lighthouse");
  await waitFor(async () => (await rowTexts(crew)).some((text) => text.startsWith(titles["/beta"])), {
    message: `the blank tab lists "${titles["/beta"]}"`,
  });
  assert.ok(
    !(await rowTexts(crew)).some((text) => text.startsWith(titles["/alpha"])),
    "the other page does not match the query",
  );
  await page.getByRole("option", { name: new RegExp(`^${titles["/beta"]}`) }).click();
  await waitFor(() => hits(server, "/beta") === 2, { message: "the picked page loads again, in a tab of its own" });

  // An address nobody visited opens the same way.
  await openPage("/gamma");
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

  // The last tab dragged to the front: past the 5px a press needs to come off, in steps.
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
