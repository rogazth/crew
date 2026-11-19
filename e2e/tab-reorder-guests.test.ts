// Reordering the strip moves no page: every guest keeps its process, its form
// and its scripts, and its element keeps its place in the document. A guest
// whose element is reparented is destroyed by Electron, and the pane takes that
// for a crash and reloads it.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, newSession, savedStrip, stripTabIds, waitFor, workspaceMark, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
/** Page loads by path: a reload shows here even when the guest survives. */
const loads: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    loads.push(at);
    // A page that takes a while, so a reorder can land mid-load.
    const html = `<!doctype html><title>Page ${at}</title><input id="t" aria-label="note"><a id="o" target="_blank" href="/p5">open</a><h1>${at}</h1>`;
    setTimeout(() => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html), at.startsWith("/slow") ? 3000 : 0);
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

const pill = (id: string) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);

/**
 * The strip crewd keeps, as these pages and the chat in between would leave it,
 * brought up by a reload. Tabs restored with a strip start cold until looked at.
 */
async function seed(workspaceId: string, session: string, paths: string[]): Promise<Record<string, string>> {
  const ids = Object.fromEntries(paths.map((path) => [path, `browser:reorder${path.replace("/", "-")}`]));
  const page = (path: string) => ({ id: ids[path]!, kind: "browser", url: `${origin}${path}`, title: "" });
  const [first, second, ...rest] = paths;
  const tabs = [page(first!), page(second!), { id: session, kind: "session", sessionId: session.replace("session:", "") }, ...rest.map(page)];
  await crew.request("state_set", {
    key: `tabs:${workspaceId}`,
    value: JSON.stringify({ tabs, activeId: ids[first!], recent: [ids[first!]] }),
  });
  await crew.window.reload();
  await waitFor(async () => (await stripTabIds(crew)).length === tabs.length, { message: "the seeded strip is back" });
  return ids;
}

/** Looks at each page in turn, so every one has its guest. */
async function wake(ids: string[]): Promise<void> {
  for (const id of ids) {
    await pill(id).click();
    await waitFor(async () => (await guests()).length >= ids.indexOf(id) + 1, { message: `${id} has its guest` });
  }
}

/** Drags the tab `id` onto the place of the tab `over`, past the 5px a press needs to come off. */
async function drag(id: string, over: string): Promise<void> {
  const from = await pill(id).boundingBox();
  const to = await pill(over).boundingBox();
  assert.ok(from && to);
  const page = crew.window;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + (to.x < from.x ? -8 : 8), from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x < from.x ? to.x + 4 : to.x + to.width - 4, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

/** Drags `id` onto `over` and waits for the strip to show the order it should. */
async function move(id: string, over: string): Promise<void> {
  const ids = await stripTabIds(crew);
  const expected = ids.filter((other) => other !== id);
  expected.splice(expected.indexOf(over) + (ids.indexOf(over) < ids.indexOf(id) ? 0 : 1), 0, id);
  await drag(id, over);
  await waitFor(async () => JSON.stringify(await stripTabIds(crew)) === JSON.stringify(expected), {
    message: `the strip shows the dragged order ${JSON.stringify(expected)}`,
  }).catch(async (error: Error) => {
    throw new Error(`${error.message}; it shows ${JSON.stringify(await stripTabIds(crew))}`);
  });
}

type Probe = { destroyed: boolean; mark: string | null; typed: string | null };

/** The guests the window holds, by the path they show; each is remembered the first time it is seen. */
const guests = () =>
  crew.app.evaluate(({ webContents }) => {
    const known = ((globalThis as { __guests?: Map<string, Electron.WebContents> }).__guests ??= new Map());
    for (const view of webContents.getAllWebContents()) {
      if (view.getType() !== "webview" || view.isDestroyed()) continue;
      const path = new URL(view.getURL()).pathname;
      if (!known.has(path) || known.get(path)!.isDestroyed()) known.set(path, view);
    }
    return [...known.entries()].filter(([, view]) => !view.isDestroyed()).map(([path, view]) => [path, view.id] as const);
  });

/** Types into the page's field and sets a counter, so a reload shows as a loss. */
async function mark(path: string): Promise<void> {
  await crew.app.evaluate(async (_electron, at) => {
    const view = (globalThis as { __guests?: Map<string, Electron.WebContents> }).__guests?.get(at);
    if (!view) throw new Error(`no guest for ${at}`);
    await view.executeJavaScript(
      `window.__mark = "mark ${at}"; document.getElementById("t").value = "typed ${at}"; true`,
    );
  }, path);
}

/** What each remembered guest holds now, or that it was destroyed. */
function probe(): Promise<Record<string, Probe>> {
  return crew.app.evaluate(async () => {
    const known = (globalThis as { __guests?: Map<string, Electron.WebContents> }).__guests ?? new Map();
    const out: Record<string, { destroyed: boolean; mark: string | null; typed: string | null }> = {};
    for (const [path, view] of known) {
      if (view.isDestroyed()) {
        out[path] = { destroyed: true, mark: null, typed: null };
        continue;
      }
      const state = (await view
        .executeJavaScript(`[window.__mark ?? null, document.getElementById("t")?.value ?? null]`)
        .catch(() => [null, null])) as [string | null, string | null];
      out[path] = { destroyed: false, mark: state[0], typed: state[1] };
    }
    return out;
  });
}

/** Keeps the document's order of pages: the elements themselves, so a move shows even when nothing reloads. */
const remember = () =>
  crew.window.evaluate(() => {
    (window as unknown as { __views: Element[] }).__views = [...document.querySelectorAll("webview")];
  });

/** The pages still in the document, in the order they had when `remember` ran. */
const inPlace = (): Promise<boolean> =>
  crew.window.evaluate(() => {
    const before = (window as unknown as { __views: Element[] }).__views;
    const now = [...document.querySelectorAll("webview")];
    return before.length === now.length && before.every((view, at) => view === now[at]);
  });

/** No remembered guest was destroyed or reloaded, and each page's element is where it was. */
async function assertUntouched(live: string[], when: string): Promise<void> {
  const state = await probe();
  for (const path of live) {
    assert.equal(state[path]?.destroyed, false, `${path}: its guest was destroyed ${when}`);
    assert.equal(state[path]?.mark, `mark ${path}`, `${path}: its script state was lost ${when}`);
    assert.equal(state[path]?.typed, `typed ${path}`, `${path}: its field was lost ${when}`);
  }
  assert.ok(await inPlace(), `a page was moved in the document ${when}`);
}

test("reordering tabs keeps every live page: the guests, their forms and the document order", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const paths = ["/p1", "/p2", "/p3", "/p4"];
  // A chat between the pages, so the order mixes kinds.
  await newSession(crew, workspace.id);
  const session = (await stripTabIds(crew))[0]!;
  const byPath = await seed(workspace.id, session, paths);
  const [p1, p2, p3, p4] = paths.map((path) => byPath[path]!) as [string, string, string, string];
  assert.deepEqual(await stripTabIds(crew), [p1, p2, session, p3, p4]);
  await wake([p1, p2, p3, p4]);
  await waitFor(async () => (await guests()).length === 4, { message: "every page has its guest" });
  for (const path of paths) await mark(path);
  await remember();
  const loaded = loads.length;

  // The last page to the front, the first to the end, then a swap across the chat.
  await move(p4, p1);
  await assertUntouched(paths, "after the last page moved to the front");
  await move(p1, p3);
  await assertUntouched(paths, "after a page moved right");
  await move(p2, p4);
  await assertUntouched(paths, "after a page moved left");
  await move(session, p1);
  await assertUntouched(paths, "after the chat moved");
  assert.equal(loads.length, loaded, `a reorder reloaded a page: ${JSON.stringify(loads.slice(loaded))}`);

  // A link opens a tab beside its page, and a tab closes: nothing around them moves.
  const opener = (await guests()).find(([path]) => path === "/p3")!;
  await crew.app.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id)?.executeJavaScript(`document.getElementById("o").click()`, true);
  }, opener[1]);
  const p5 = await waitFor(
    async () => (await stripTabIds(crew)).find((id) => ![p1, p2, p3, p4, session].includes(id)),
    { message: "the link opens a tab" },
  );
  await waitFor(async () => (await guests()).some(([path]) => path === "/p5"), { message: "the new page has its guest" });
  await mark("/p5");
  await remember();
  const before = loads.length;
  await pill(p2).hover();
  await pill(p2).getByRole("button", { name: "Close tab" }).click();
  await waitFor(async () => !(await stripTabIds(crew)).includes(p2), { message: "the page closes" });
  await crew.window.evaluate(() => {
    const views = (window as unknown as { __views: Element[] }).__views;
    (window as unknown as { __views: Element[] }).__views = views.filter((view) => view.isConnected);
  });
  await assertUntouched(["/p1", "/p3", "/p4", "/p5"], "after one page opened and another closed");
  await move(p5, (await stripTabIds(crew))[0]!);
  await assertUntouched(["/p1", "/p3", "/p4", "/p5"], "after the new page moved");
  assert.equal(loads.length, before, `a reorder reloaded a page: ${JSON.stringify(loads.slice(before))}`);
});

test("reordering tabs leaves cold pages cold and live ones alone", async () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const session = (await stripTabIds(crew)).find((id) => id.startsWith("session:"))!;
  const byPath = await seed(workspace.id, session, ["/p1", "/p2", "/p3", "/p4"]);
  const [p1, p2, p3, p4] = ["/p1", "/p2", "/p3", "/p4"].map((path) => byPath[path]!) as [string, string, string, string];

  // A restored strip is cold but for the page on screen. Two more are looked at; /p2 stays cold.
  await waitFor(async () => (await guests()).some(([at]) => at === "/p1"), { message: "the page on screen has its guest" });
  for (const [id, path] of [[p3, "/p3"], [p4, "/p4"]] as const) {
    await pill(id).click();
    await waitFor(async () => (await guests()).some(([at]) => at === path), { message: `${path} has its guest` });
  }
  await pill(p1).click();
  const live = ["/p1", "/p3", "/p4"];
  for (const path of live) await mark(path);
  await remember();
  const loaded = loads.length;
  const count = (await guests()).length;
  assert.equal(count, 3, "one page is cold");

  await move(p2, p1);
  await assertUntouched(live, "after the cold page moved to the front");
  await move(p1, p2);
  await assertUntouched(live, "after a live page moved past the cold one");
  await move(p4, (await stripTabIds(crew))[0]!);
  await assertUntouched(live, "after another live page moved");
  await move(session, p3);
  await assertUntouched(live, "after the chat moved");
  assert.equal((await guests()).length, count, "a reorder woke or dropped a guest");
  assert.equal(loads.length, loaded, `a reorder reloaded a page: ${JSON.stringify(loads.slice(loaded))}`);

  // The cold page still wakes from its place.
  await pill(p2).click();
  await waitFor(async () => (await guests()).some(([at]) => at === "/p2"), { message: "the cold page wakes" });
});

/** Seeds a strip of pages alone in `workspaceId`, shown the next time the workspace is. */
async function seedPages(workspaceId: string, paths: string[]): Promise<string[]> {
  const ids = paths.map((path) => `browser:reorder${path.replace("/", "-")}`);
  const tabs = paths.map((path, n) => ({ id: ids[n]!, kind: "browser", url: `${origin}${path}`, title: "" }));
  await crew.request("state_set", {
    key: `tabs:${workspaceId}`,
    value: JSON.stringify({ tabs, activeId: ids[0], recent: [ids[0]] }),
  });
  return ids;
}

/** The webContents id of the remembered guest at `path`. */
const guestId = async (path: string) => (await guests()).find(([at]) => at === path)?.[1];

test("no page reloads when tabs move while pinned, inspected, loading, driven or in another workspace", async () => {
  const [first] = crew.workspaces;
  assert.ok(first);
  const second = await crew.addWorkspace(mkdtempSync(path.join(tmpdir(), "crew-reorder-")), "second");
  const [w1, w2, w3, w4] = await seedPages(first.id, ["/w1", "/w2", "/w3", "/w4"]);
  const [v1, v2] = await seedPages(second.id, ["/v1", "/v2"]);
  await crew.window.reload();
  // The second workspace is on screen after the reload: its pages wake first.
  await waitFor(async () => (await stripTabIds(crew)).includes(v1!), { message: "the second workspace's strip is back" });
  await wake([v1!, v2!]);
  await workspaceMark(crew, first.name).click();
  await waitFor(async () => (await stripTabIds(crew)).includes(w1!), { message: "the first workspace's strip is back" });
  for (const id of [w1!, w2!, w3!, w4!]) {
    await pill(id).click();
    const at = `/${id.split("-").pop()}`;
    await waitFor(async () => (await guests()).some(([path]) => path === at), { message: `${at} has its guest` });
  }
  const live = ["/v1", "/v2", "/w1", "/w2", "/w3", "/w4"];
  for (const path of live) await mark(path);
  await remember();
  const loaded = loads.length;

  // Pinning a tab sends it to the strip's left end, and unpinning brings it back among the others.
  const menu = async (id: string, action: string) => {
    await crew.window.locator(`[role="tab"][data-tab-id="${id}"]`).click({ button: "right" });
    await crew.window.getByRole("menuitem", { name: action }).click();
  };
  const leads = async () => (await savedStrip(crew, first.id))?.ids[0];
  await menu(w3!, "Pin tab");
  await waitFor(async () => (await leads()) === w3, { message: "the pinned tab leads the strip" });
  await assertUntouched(live, "after a tab was pinned");
  await menu(w3!, "Unpin tab");
  await waitFor(async () => (await stripTabIds(crew)).includes(w3!), { message: "the unpinned tab is back among the others" });
  await assertUntouched(live, "after a tab was unpinned");

  // DevTools docked under the page on screen stay open while it moves.
  await pill(w4!).click();
  await crew.window.getByRole("button", { name: "Developer tools", exact: true }).click();
  await crew.window.locator("[data-devtools]").waitFor();
  await move(w4!, (await stripTabIds(crew))[0]!);
  await assertUntouched(live, "after a page with DevTools docked moved");
  assert.equal(await crew.window.locator("[data-devtools]").count(), 1, "DevTools stayed docked");
  await crew.window.getByRole("button", { name: "Developer tools", exact: true }).click();
  await waitFor(async () => (await crew.window.locator("[data-devtools]").count()) === 0, { message: "DevTools close" });

  // A page halfway through a load finishes it once, in the same guest.
  const loading = (await guestId("/w2"))!;
  await crew.app.evaluate(({ webContents }, [id, url]) => {
    void webContents.fromId(id as number)?.loadURL(url as string);
  }, [loading, `${origin}/slow-w2`]);
  await waitFor(() => Promise.resolve(loads.includes("/slow-w2")), { message: "the slow page is asked for" });
  await move(w2!, w4!);
  await waitFor(
    () => crew.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL().endsWith("/slow-w2") && !webContents.fromId(id)?.isLoading(), loading),
    { message: "the slow page finishes in the same guest" },
  );
  assert.equal(loads.filter((at) => at === "/slow-w2").length, 1, "the page loading as it moved was asked for again");
  const settled = live.filter((path) => path !== "/w2");

  // A page an agent drives out of sight sits staged under the page on screen; moving it keeps it.
  const opened = await crew.request<{ type: string; text?: string }[]>("browser_tool", {
    workspaceId: first.id,
    tool: "open_tab",
    args: { url: `${origin}/held` },
  });
  const held = /Opened (browser:\S+)/.exec(opened.map((block) => block.text ?? "").join("\n"))?.[1];
  assert.ok(held, JSON.stringify(opened));
  await waitFor(async () => (await guests()).some(([path]) => path === "/held"), { message: "the driven page has its guest" });
  await mark("/held");
  await remember();
  await move(held, (await stripTabIds(crew))[0]!);
  await move(w1!, held);
  await assertUntouched([...settled, "/held"], "after a driven page and its neighbors moved");
  await crew.request("browser_lease_release", { tab: held });

  // The other workspace's strip moves too, and the way back finds every page as it was.
  await workspaceMark(crew, second.name).click();
  await waitFor(async () => (await stripTabIds(crew)).includes(v1!), { message: "the second workspace is on screen" });
  await move(v2!, v1!);
  await workspaceMark(crew, first.name).click();
  await waitFor(async () => (await stripTabIds(crew)).includes(w1!), { message: "back on the first workspace" });
  await move(w3!, (await stripTabIds(crew))[0]!);
  await assertUntouched([...settled, "/held"], "after both workspaces' strips moved and the window switched back");
  assert.deepEqual(
    loads.slice(loaded).filter((at) => at !== "/slow-w2" && at !== "/held"),
    [],
    "a move reloaded a page",
  );
});
