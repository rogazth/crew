// I1: an incognito tab (⇧⌘N) opens in the workspace's in-memory session. It
// sees none of the workspace's cookies and leaves none behind: no history, no
// saved back/forward stack, no place in the saved strip. Incognito tabs share
// their session with each other, the tabs their pages open are incognito too,
// and the session is wiped once the last of them closes. ⇧⌘B opens a regular
// page, and the launcher's ⌥↵ opens a typed address incognito.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, savedStrip, stripTabIds, waitFor, type Crew } from "./harness.ts";
import { partitionFor } from "../src/lib/browser/bridge.ts";

type Visit = { path: string; cookie: string };

let crew: Crew;
let server: Server;
let origin = "";
const visits: Visit[] = [];

before(async () => {
  // `/set/<value>` signs in as <value>; `/links` holds a target=_blank link; every other path is a page named by it.
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") return void response.writeHead(404).end();
    visits.push({ path: at, cookie: request.headers.cookie ?? "" });
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (at.startsWith("/set/")) headers["set-cookie"] = `sid=${at.slice(5)}; Path=/; Max-Age=3600`;
    response.writeHead(200, headers);
    const body = at === "/links" ? `<a id="out" href="/popped" target="_blank">out</a>` : `<h1>${at}</h1>`;
    response.end(`<!doctype html><title>${at}</title>${body}`);
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

const workspaceId = () => crew.workspaces[0]!.id;

/**
 * An app chord, pressed in the window. Playwright types into the window's own
 * document, which a focused page has taken the keyboard from, so the page is
 * let go first; a chord typed inside a page has its own test.
 */
async function chord(keys: string): Promise<void> {
  await crew.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressChord(crew, keys);
}

/** The browser tabs on the strip, and which of them wear the incognito mark. */
async function browserTabs(): Promise<{ id: string; incognito: boolean }[]> {
  return crew.window
    .locator('[data-tab-strip] [role="tab"][data-tab-id^="browser:"]')
    .evaluateAll((tabs) =>
      tabs.map((tab) => ({
        id: tab.getAttribute("data-tab-id") ?? "",
        incognito: tab.hasAttribute("data-incognito"),
      })),
    );
}

/** A tab opened by `act`, once the strip shows it. */
async function newTab(act: () => Promise<void>): Promise<{ id: string; incognito: boolean }> {
  const known = new Set((await browserTabs()).map((tab) => tab.id));
  await act();
  return waitFor(async () => (await browserTabs()).find((tab) => !known.has(tab.id)), { message: "a browser tab opens" });
}

const addressBar = () => crew.window.getByLabel("Address", { exact: true }).filter({ visible: true });

/** Types `url` into the address bar on screen. */
async function go(url: string): Promise<void> {
  const bar = addressBar();
  await bar.fill(url);
  // Enter as a DOM event: the page takes the keyboard as it navigates, and a
  // CDP key-up sent after that can stall until Playwright's timeout.
  await bar.dispatchEvent("keydown", { key: "Enter", bubbles: true });
  await waitFor(() => visits.some((visit) => visit.path === new URL(url).pathname), { message: `${url} loads` });
  await waitFor(() => sessionOf(url), { message: `${url} commits` });
}

/** Which of the workspace's sessions the page showing `url` lives in. */
function sessionOf(url: string): Promise<"saved" | "incognito" | null> {
  return crew.app.evaluate(
    ({ webContents, session }, [target, saved, incognito]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === target);
      if (!guest) return null;
      if (guest.session === session.fromPartition(saved!)) return "saved";
      if (guest.session === session.fromPartition(incognito!)) return "incognito";
      return null;
    },
    [url, partitionFor(workspaceId()), partitionFor(workspaceId(), true)] as const,
  );
}

function cookiesIn(incognito: boolean): Promise<string[]> {
  return crew.app.evaluate(
    async ({ session }, partition) =>
      (await session.fromPartition(partition!).cookies.get({})).map((c) => `${c.name}=${c.value}`).sort(),
    partitionFor(workspaceId(), incognito),
  );
}

function lastVisit(path: string): Visit {
  const visit = visits.findLast((v) => v.path === path);
  assert.ok(visit, `${path} was visited`);
  return visit;
}

async function historyHas(path: string): Promise<boolean> {
  const rows = await crew.request<{ url: string }[]>("browser_history_suggest", { text: path.slice(1), limit: 50 });
  return rows.some((row) => new URL(row.url).pathname === path);
}

async function closeTab(id: string): Promise<void> {
  await crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`).click();
  await chord(`${MOD}+w`);
  await waitFor(async () => !(await stripTabIds(crew)).includes(id), { message: "the tab closes" });
}

let regularId = "";
let firstIncognitoId = "";

test("⇧⌘B opens a regular page in the workspace's saved session, signed in there", async () => {
  const tab = await newTab(() => chord(`${MOD}+Shift+b`));
  regularId = tab.id;
  assert.equal(tab.incognito, false);
  await waitFor(() => addressBar().evaluate((el) => el === document.activeElement), { message: "the address bar has focus" });
  await go(`${origin}/set/regular`);
  assert.equal(await sessionOf(`${origin}/set/regular`), "saved");
  await waitFor(async () => (await cookiesIn(false)).includes("sid=regular"), { message: "the saved session holds the cookie" });
  await waitFor(() => historyHas("/set/regular"), { message: "the visit reaches history" });
});

test("⇧⌘N opens an incognito page that sees none of the saved session's cookies", async () => {
  const tab = await newTab(() => chord(`${MOD}+Shift+n`));
  firstIncognitoId = tab.id;
  assert.equal(tab.incognito, true, "the tab wears the incognito mark");
  await waitFor(() => addressBar().evaluate((el) => el === document.activeElement), { message: "the address bar has focus" });
  await crew.window.getByText("Incognito", { exact: true }).filter({ visible: true }).waitFor();
  await go(`${origin}/private-first`);
  assert.equal(await sessionOf(`${origin}/private-first`), "incognito");
  assert.doesNotMatch(lastVisit("/private-first").cookie, /sid=/);

  // Signing in here stays here.
  await go(`${origin}/set/secret`);
  await waitFor(async () => (await cookiesIn(true)).includes("sid=secret"), { message: "the incognito session holds its cookie" });
  assert.ok(!(await cookiesIn(false)).includes("sid=secret"), "the saved session never gets it");
  await go(`${origin}/private-second`);
  assert.match(lastVisit("/private-second").cookie, /sid=secret/);
});

test("an incognito page leaves no history, no saved stack and no place in the saved strip", async () => {
  // Past the 2s a regular page waits before saving its stack.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(await historyHas("/private-first"), false);
  assert.equal(await historyHas("/set/secret"), false);
  assert.equal(await historyHas("/private-second"), false);
  assert.equal(await crew.request("browser_page_get", { pageId: firstIncognitoId }), null);
  assert.notEqual(await crew.request("browser_page_get", { pageId: regularId }), null, "the regular page's stack is saved");

  const strip = await waitFor(() => savedStrip(crew, workspaceId()), { message: "the strip is saved" });
  assert.ok(strip.ids.includes(regularId));
  assert.ok(!strip.ids.includes(firstIncognitoId), "the incognito tab is not written");
  assert.ok(!strip.recent.includes(firstIncognitoId));
  const raw = await crew.request<string>("state_get", { key: `tabs:${workspaceId()}` });
  assert.doesNotMatch(raw, /private|secret/);
});

test("incognito tabs share one session, and the tabs their pages open are incognito too", async () => {
  // A second incognito tab is signed in as the first.
  const second = await newTab(() => chord(`${MOD}+Shift+n`));
  assert.equal(second.incognito, true);
  await go(`${origin}/links`);
  assert.match(lastVisit("/links").cookie, /sid=secret/);

  // target=_blank from an incognito page.
  const popped = await newTab(() =>
    crew.app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === target);
      await guest?.executeJavaScript(`document.getElementById("out").click()`, true);
    }, `${origin}/links`),
  );
  assert.equal(popped.incognito, true, "the opened tab is incognito");
  await waitFor(() => sessionOf(`${origin}/popped`), { message: "the opened tab loads" });
  assert.match(lastVisit("/popped").cookie, /sid=secret/);
  assert.equal(await sessionOf(`${origin}/popped`), "incognito");
});

test("the launcher's ⌥↵ opens a typed address in an incognito tab", async () => {
  const tab = await newTab(async () => {
    await chord(`${MOD}+t`);
    const field = crew.window.getByLabel("Open a tab");
    await field.fill(`${origin}/from-launcher`);
    await crew.window.getByText("⌥↵").waitFor();
    await field.press("Alt+Enter");
  });
  assert.equal(tab.incognito, true);
  await waitFor(() => sessionOf(`${origin}/from-launcher`), { message: "the page loads" });
  assert.equal(await sessionOf(`${origin}/from-launcher`), "incognito");
  assert.match(lastVisit("/from-launcher").cookie, /sid=secret/);
});

test("⇧⌘N works with the keyboard inside a page", async () => {
  const tab = await newTab(() =>
    crew.app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === target);
      if (!guest) throw new Error("no page");
      guest.focus();
      const modifiers = [process.platform === "darwin" ? "meta" : "control", "shift"] as ("meta" | "control" | "shift")[];
      guest.sendInputEvent({ type: "keyDown", keyCode: "N", modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: "N", modifiers });
    }, `${origin}/from-launcher`),
  );
  assert.equal(tab.incognito, true);
});

test("closing the last incognito tab wipes the session; the next one starts signed out", async () => {
  const open = (await browserTabs()).filter((tab) => tab.incognito);
  assert.ok(open.length >= 2);
  // With one still open, nothing goes.
  for (const tab of open.slice(1)) await closeTab(tab.id);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok((await cookiesIn(true)).includes("sid=secret"), "one incognito tab left keeps the session");

  await closeTab(open[0]!.id);
  await waitFor(async () => (await cookiesIn(true)).length === 0, { message: "the incognito session is wiped" });
  assert.ok((await cookiesIn(false)).includes("sid=regular"), "the saved session is untouched");

  await newTab(() => chord(`${MOD}+Shift+n`));
  await go(`${origin}/after-wipe`);
  assert.doesNotMatch(lastVisit("/after-wipe").cookie, /sid=/);
});

test("incognito tabs do not come back after a restart; regular ones do", async () => {
  crew = await crew.restart();
  await waitFor(async () => (await stripTabIds(crew)).includes(regularId), { message: "the regular page comes back" });
  assert.deepEqual(
    (await browserTabs()).filter((tab) => tab.incognito),
    [],
    "no incognito tab comes back",
  );
  assert.equal((await browserTabs()).length, 1);
});

test("⇧⌘A still opens the new agent sheet", async () => {
  await chord(`${MOD}+Shift+a`);
  const sheet = crew.window.getByRole("dialog", { name: "New agent" });
  await sheet.waitFor();
  await sheet.getByPlaceholder("e.g. Research").click();
  await crew.window.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
});
