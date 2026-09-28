// What a page needs from the browser around it: its downloads listed and
// actionable, its questions (a permission, a site's sign-in, another app)
// asked over it, and the toolbar's floating panels gone once its tab is.
// A local server is the only web: it serves a file to download, a page that
// asks for things, and a folder behind basic auth.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { externalOpens, launchCrew, MOD, pressChord, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
const FILE = "report contents\n";

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/report.txt") {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
      response.end(FILE);
      return;
    }
    if (at === "/secret") {
      const expected = `Basic ${Buffer.from("me:pw").toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="Staging"', "content-type": "text/plain" });
        response.end("no");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Inside</title><h1>Inside</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${at}</title><h1>${at}</h1><a id="report" href="/report.txt">report</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  crew = await launchCrew();
  // Downloads land in the sandbox, not in the Downloads folder of whoever runs this.
  await crew.app.evaluate(({ app }, dir) => app.setPath("downloads", dir), crew.home);
});

after(async () => {
  await crew?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function openPage(url: string): Promise<void> {
  const before = (await stripTabIds(crew)).length;
  // The strip's button, not ⌘T: a page that took focus back from a closed menu keeps synthetic keys.
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
  await waitFor(() => inPage(url, "document.readyState === 'complete'"), { message: `${url} loads` });
}

/** Runs `code` in the page showing `url`, as a click would (with a user gesture). */
function inPage<T = unknown>(url: string, code: string): Promise<T> {
  return crew.app.evaluate(
    async ({ webContents }, [target, source]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getURL() === target);
      if (!guest) return null;
      return guest.executeJavaScript(source!, true);
    },
    [url, code],
  ) as Promise<T>;
}

async function shot(name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`) });
}

test("a download shows in the toolbar, with its progress and where it went", async () => {
  const url = `${origin}/downloads`;
  await openPage(url);
  await inPage(url, `document.getElementById("report").click()`);
  const button = crew.window.getByRole("button", { name: "Downloads" });
  await button.waitFor();
  await button.click();
  const row = crew.window.getByText("report.txt", { exact: true });
  await row.waitFor();
  await crew.window.getByText(`${FILE.length} B`).waitFor();
  await shot("downloads");
  assert.equal(await readFile(path.join(crew.home, "report.txt"), "utf8"), FILE);
  await crew.window.getByRole("button", { name: "Show in Finder" }).waitFor();
  await crew.window.keyboard.press("Escape");
});

test("a site's permission is asked over its page and a block is remembered", async () => {
  const url = `${origin}/maps`;
  await openPage(url);
  void inPage(url, `new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("yes"), (e) => resolve("no:" + e.code)))`);
  const prompt = crew.window.getByRole("dialog", { name: "127.0.0.1:" + new URL(origin).port + " wants to" }).or(
    crew.window.getByRole("dialog", { name: `${origin} wants to` }),
  );
  await prompt.first().waitFor();
  await crew.window.getByText("Know your location").waitFor();
  await shot("permission");
  await prompt.first().getByRole("button", { name: "Block" }).click();
  await prompt.first().waitFor({ state: "detached" });
  // Asked again, the site is refused without a word.
  const second = await inPage<string>(
    url,
    `new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("yes"), (e) => resolve("no:" + e.code)))`,
  );
  assert.equal(second, "no:1");
  assert.equal(await crew.window.getByRole("dialog").count(), 0);

  // The page's ⋯ menu shows it, and Settings can take it back.
  await crew.window.getByRole("button", { name: "More" }).click();
  await crew.window.getByRole("menuitem", { name: "Site Permissions" }).hover();
  await crew.window.getByRole("menuitemcheckbox", { name: /Location/ }).filter({ hasText: "Blocked" }).waitFor();
  await shot("site-permissions");
  await crew.window.keyboard.press("Escape");
  await crew.window.keyboard.press("Escape");
});

test("the ⋯ menu closes when its tab is switched away from with the keyboard", async () => {
  await crew.window.getByRole("button", { name: "More" }).click();
  const menu = crew.window.getByRole("menu", { name: "More" });
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Print…" }).waitFor();
  await pressChord(crew, `${MOD}+Shift+[`);
  await menu.waitFor({ state: "detached" });
});

test("another app's link waits for a yes", async () => {
  const url = `${origin}/call`;
  await openPage(url);
  await inPage(url, `location.href = "facetime://someone@example.com"`);
  const prompt = crew.window.getByRole("dialog", { name: /^Open FaceTime\?$/ });
  await prompt.waitFor();
  await shot("external");
  assert.deepEqual(await externalOpens(crew), []);
  await prompt.getByRole("button", { name: "Open FaceTime" }).click();
  await waitFor(async () => (await externalOpens(crew)).includes("facetime://someone@example.com"), {
    message: "the link goes to its app",
  });
});

test("a site's own sign-in is asked for over the page", async () => {
  const url = `${origin}/secret`;
  const before = (await stripTabIds(crew)).length;
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
  const prompt = crew.window.getByRole("dialog", { name: /^Sign in to / });
  await prompt.waitFor();
  await prompt.getByText("The site says: “Staging”").waitFor();
  await prompt.getByLabel("Username").fill("me");
  await prompt.getByLabel("Password").fill("pw");
  await shot("auth");
  await crew.window.keyboard.press("Enter");
  await prompt.waitFor({ state: "detached" });
  await waitFor(() => inPage(url, `document.title === "Inside"`), { message: "the page loads signed in" });
});

test("Settings lists the site and the download choice", async () => {
  await crew.window.getByRole("button", { name: "More" }).click();
  await crew.window.getByRole("menuitem", { name: "Settings" }).click();
  await crew.window.getByRole("heading", { name: "Browser", level: 1 }).waitFor();
  await crew.window.getByText("Ask where to save each file").waitFor();
  await crew.window.getByText("Blocked: Location").waitFor();
  await shot("settings");
});
