// C1: importing another browser's cookies. A Chrome profile planted in the
// sandbox's HOME shows up in Settings › Browser › Cookies by the name the user gave
// it, and a list of cookies handed to main lands in the pages' session. The
// keychain read in between is left out: it would ask for the real login keychain.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { launchCrew, MOD, pressChord, type Crew } from "./harness.ts";
import type { CookieSource, ImportedCookie } from "../src/lib/protocol.ts";
import { PARTITION } from "../src/lib/browser/bridge.ts";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
  const chrome = path.join(crew.home, "Library/Application Support/Google/Chrome");
  await mkdir(path.join(chrome, "Profile 2/Network"), { recursive: true });
  await writeFile(path.join(chrome, "Profile 2/Network/Cookies"), "");
  // A folder without a cookie database is not offered.
  await mkdir(path.join(chrome, "Profile 3"), { recursive: true });
  await writeFile(path.join(chrome, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Work" } } } }));
});

after(async () => {
  await crew?.close();
});

test("a Chrome profile with cookies is offered under its own name", async () => {
  const sources = await crew.request<CookieSource[]>("browser_cookie_sources");
  assert.deepEqual(sources, [{ id: "chrome/Profile 2", browser: "Chrome", profile: "Work" }]);

  const page = crew.window;
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByText("Import from a browser").waitFor();
  const picker = page.getByRole("combobox", { name: "Browser profile" });
  assert.equal((await picker.textContent())?.trim(), "Chrome — Work");
  await page.getByRole("button", { name: "Import", exact: true }).waitFor();
});

test("a source outside the known browsers and profiles is refused", async () => {
  await assert.rejects(crew.request("browser_cookies_read", { sourceId: "chrome/../../.ssh" }), /Unknown profile/);
  await assert.rejects(crew.request("browser_cookies_read", { sourceId: "firefox/Default" }), /Unknown browser/);
});

test("imported cookies land in the pages' session, malformed ones are counted", async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const cookies: (ImportedCookie | { host: string })[] = [
    { host: ".example.com", name: "sid", value: "one", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires },
    { host: "app.example.com", name: "__Host-t", value: "two", path: "/x", secure: true, httpOnly: false, sameSite: "strict" },
    { host: "bad host" },
  ];
  const result = await crew.window.evaluate((list) => window.crewHost!.browser.importCookies(list as ImportedCookie[]), cookies);
  assert.deepEqual(result, { imported: 2, failed: 1 });

  const stored = await crew.app.evaluate(async ({ session }, partition) => {
    const all = await session.fromPartition(partition).cookies.get({});
    return all
      .filter((c) => c.domain?.includes("example.com"))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, session: c.session }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, PARTITION);
  assert.deepEqual(stored, [
    { name: "__Host-t", value: "two", domain: "app.example.com", hostOnly: true, path: "/", session: true },
    { name: "sid", value: "one", domain: ".example.com", hostOnly: false, path: "/", session: false },
  ]);
});
