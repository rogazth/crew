// C1: each workspace's pages keep their own cookies, and another browser's can
// be imported into one of them from the page's ⋯ menu. A Chrome profile planted
// in the sandbox's HOME is what the menu offers; the keychain read behind the
// dialog is left out, since it would ask for the real login keychain, so the
// cookies go straight to main the way the dialog hands them over.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, stripTabIds, waitFor, type Crew } from "./harness.ts";
import { LEGACY_PARTITION, partitionFor } from "../src/lib/browser/bridge.ts";
import type { CookieSource, ImportedCookie } from "../src/lib/protocol.ts";

type Visit = { path: string; cookie: string };

let crew: Crew;
let server: Server;
let origin = "";
const visits: Visit[] = [];

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at !== "/favicon.ico") visits.push({ path: at, cookie: request.headers.cookie ?? "" });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${at}</title><h1>${at}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  crew = await launchCrew({ repos: ["alpha", "beta"] });
  const chrome = path.join(crew.home, "Library/Application Support/Google/Chrome");
  await mkdir(path.join(chrome, "Profile 2/Network"), { recursive: true });
  await writeFile(path.join(chrome, "Profile 2/Network/Cookies"), "");
  // A folder without a cookie database is not offered.
  await mkdir(path.join(chrome, "Profile 3"), { recursive: true });
  await writeFile(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Work" } } } }));

  // What an older Crew left: one partition every page shared.
  await crew.app.evaluate(async ({ session }, [partition, url]) => {
    const ses = session.fromPartition(partition!);
    await ses.cookies.set({ url: url!, name: "legacy", value: "kept", expirationDate: Date.now() / 1000 + 3600 });
    await ses.cookies.flushStore();
  }, [LEGACY_PARTITION, origin]);
});

after(async () => {
  await crew?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** Opens `url` in a new tab of the active workspace, through ⌘T. */
async function openPage(url: string): Promise<void> {
  const before = (await stripTabIds(crew)).length;
  await pressChord(crew, `${MOD}+t`);
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
}

function sessionCookies(workspaceId: string): Promise<string[]> {
  return crew.app.evaluate(
    async ({ session }, partition) =>
      (await session.fromPartition(partition!).cookies.get({})).map((c) => `${c.name}=${c.value}`).sort(),
    partitionFor(workspaceId),
  );
}

function workspace(index: number) {
  const found = crew.workspaces[index];
  assert.ok(found);
  return found;
}

test("a workspace's first page starts from the cookies pages shared before", async () => {
  await openPage(`${origin}/alpha`);
  await waitFor(() => visits.some((visit) => visit.path === "/alpha"), { message: "the page loads" });
  await waitFor(async () => (await sessionCookies(workspace(0).id)).includes("legacy=kept"), {
    message: "alpha's session holds the shared cookie",
  });
});

test("the ⋯ menu zooms in place and offers the Chrome profile by its name", async () => {
  const page = crew.window;
  await page.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Zoom in" }).click();
  await menu.getByRole("menuitem", { name: "Reset zoom" }).filter({ hasText: "110%" }).waitFor();
  await menu.getByRole("menuitem", { name: "Reset zoom" }).click();
  await menu.getByRole("menuitem", { name: "Reset zoom" }).filter({ hasText: "100%" }).waitFor();

  await menu.getByRole("menuitem", { name: "Import Cookies" }).hover();
  const profile = page.getByRole("menuitem", { name: "Chrome — Work" });
  await profile.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("Import cookies from Chrome — Work?").waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Browser", level: 1 }).waitFor();
  await pressChord(crew, `${MOD}+,`);
});

test("the daemon lists the profile and refuses anything outside the known browsers", async () => {
  const sources = await crew.request<CookieSource[]>("browser_cookie_sources");
  assert.deepEqual(sources, [{ id: "chrome/Profile 2", browser: "Chrome", profile: "Work" }]);
  await assert.rejects(crew.request("browser_cookies_read", { sourceId: "chrome/../../.ssh" }), /Unknown profile/);
  await assert.rejects(crew.request("browser_cookies_read", { sourceId: "firefox/Default" }), /Unknown browser/);
});

test("imported cookies reach only the workspace they were imported into", async () => {
  const alpha = workspace(0);
  const beta = workspace(1);
  const cookies: (ImportedCookie | { host: string })[] = [
    { host: "127.0.0.1", name: "sid", value: "alpha-user", path: "/", secure: false, httpOnly: true, sameSite: "lax", expires: Math.floor(Date.now() / 1000) + 3600 },
    { host: "bad host" },
  ];
  const result = await crew.window.evaluate(
    ([id, list]) => window.crewHost!.browser.importCookies(id as string, list as ImportedCookie[]),
    [alpha.id, cookies] as const,
  );
  assert.deepEqual(result, { imported: 1, failed: 1 });

  // alpha's page sends it on its next load.
  await pressChord(crew, `${MOD}+r`);
  await waitFor(() => visits.some((visit) => visit.path === "/alpha" && visit.cookie.includes("sid=alpha-user")), {
    message: "alpha's page loads with the imported cookie",
  });

  // beta's page never sees it.
  await crew.window
    .locator('nav[aria-label="Workspaces"][data-sidebar-rail]')
    .locator(`button[aria-label="${beta.name}"][title$="${beta.path}"]`)
    .click();
  await openPage(`${origin}/beta`);
  const visit = await waitFor(() => visits.find((v) => v.path === "/beta"), { message: "beta's page loads" });
  assert.doesNotMatch(visit.cookie, /sid=/);
  assert.ok(!(await sessionCookies(beta.id)).some((cookie) => cookie.startsWith("sid=")));
  assert.ok((await sessionCookies(alpha.id)).includes("sid=alpha-user"));
});
