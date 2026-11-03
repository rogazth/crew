// Hidden pages stay live while memory is fine and go cold when the OS says it
// runs out. A cold page comes back from its saved stack. With the window's live
// page state gone (a reload, a reopened window), its tab still shows the page's
// title and favicon, cold and once shown again.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
/** While set, pages answer this late, so a tab's page takes a while to name itself. */
let delay = 0;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/icon.png") {
      response.writeHead(200, { "content-type": "image/png" }).end(PNG);
      return;
    }
    const html = `<!doctype html><title>Title ${at}</title><link rel="icon" href="/icon.png"><h1>${at}</h1>`;
    setTimeout(() => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html), delay);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function openPage(url: string): Promise<string> {
  const before = await stripTabIds(crew);
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab")).first();
  // The launcher closes by itself if the previous page's load takes focus just
  // as it opens, so the whole attempt is made again when no tab comes of it.
  await waitFor(
    async () => {
      try {
        await crew.window.getByRole("button", { name: /^New tab/ }).click({ timeout: 2000 });
        await field.fill(url, { timeout: 2000 });
        await crew.window.keyboard.press("Enter");
      } catch {
        await crew.window.keyboard.press("Escape").catch(() => {});
        return false;
      }
      return waitFor(async () => (await stripTabIds(crew)).length > before.length, { timeout: 3000 }).then(
        () => true,
        () => false,
      );
    },
    { message: "a browser tab opens", timeout: 30_000 },
  );
  return (await stripTabIds(crew)).find((tab) => !before.includes(tab))!;
}

/** Pages with a guest up: cold ones have none. */
const liveGuests = () =>
  crew.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === "webview").length);

/** Answers the window's memory pressure question with `level` from now on. */
const pressure = (level: string) =>
  crew.app.evaluate(({ ipcMain }, answer) => {
    ipcMain.removeHandler("browser:memory-pressure");
    ipcMain.handle("browser:memory-pressure", () => answer);
  }, level);

const pill = (id: string) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);
async function face(id: string) {
  return {
    text: (await pill(id).innerText()).trim(),
    icon: await pill(id).locator("[data-favicon]").count(),
  };
}

test("a cold tab keeps its title and favicon after the window reloads", async () => {
  const first = await openPage(`${origin}/one`);
  await waitFor(async () => (await face(first)).icon === 1 && (await face(first)).text.includes("Title /one"), {
    message: "first tab shows title and favicon",
  });
  await openPage(`${origin}/two`);
  // The tab saves its icon as the page reports it; the reload must not beat the save.
  await waitFor(
    async () => {
      const strip = await crew.request<string | null>("state_get", { key: `tabs:${crew.workspaces[0]!.id}` });
      const saved = strip ? (JSON.parse(strip) as { tabs: { id: string; icon?: string }[] }) : null;
      return Boolean(saved?.tabs.find((tab) => tab.id === first)?.icon);
    },
    { message: "the first tab's icon is saved" },
  );
  // The window's renderer starts over (a relaunch, a reload after sleep): no live page state is left.
  await crew.window.reload();
  await waitFor(async () => (await stripTabIds(crew)).includes(first), { message: "strip back" });
  await waitFor(async () => (await face(first)).icon === 1, { message: "the cold tab shows its saved favicon" });
  // Every text the pill shows while its page mounts is recorded: the saved title
  // holds until the page names itself again, with no host or "New tab" in between.
  delay = 1500;
  await pill(first).evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const record = () => seen.push((element as HTMLElement).innerText.trim());
    new MutationObserver(record).observe(element, { subtree: true, childList: true, characterData: true });
  });
  await pill(first).click();
  await waitFor(async () => (await face(first)).text.includes("Title /one"), { message: "the title comes back" });
  // The late page is let through before the pill is judged.
  await crew.window.waitForTimeout(delay + 1000);
  // The pill shows a spinner in the icon's place while the page loads, and the
  // title can come back before it finishes: the icon is waited for, not sampled.
  await waitFor(async () => (await face(first)).icon === 1, { message: "the favicon comes back" });
  delay = 0;
  const seen = await crew.window.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const lost = seen.filter((text) => !text.includes("Title /one"));
  assert.deepEqual(lost, [], `the title flickered while the page mounted: ${JSON.stringify(seen)}`);
  const after = await face(first);
  assert.ok(after.text.includes("Title /one"), `title lost: ${JSON.stringify(after)}`);
  assert.equal(after.icon, 1, `favicon lost: ${JSON.stringify(after)}`);
});

test("hidden pages stay live while memory is fine, and go cold when it runs out", async () => {
  const before = await liveGuests();
  // More than the old budget of six hidden pages.
  for (let i = 0; i < 8; i++) await openPage(`${origin}/live${i}`);
  await waitFor(async () => (await liveGuests()) === before + 8, { message: "every page keeps its guest" });
  await pressure("critical");
  // The next sweep (every 30 s) leaves only the page on screen.
  await waitFor(async () => (await liveGuests()) === 1, { message: "hidden pages go cold", timeout: 60_000 });
  await pressure("normal");
});
