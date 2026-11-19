// Hidden pages stay live however long they go unseen, until the OS says memory
// is critical: then one goes a sweep, least recently used first, and never one
// with a half-filled form. A cold page comes back from its saved stack. With the window's live
// page state gone (a reload, a reopened window), its tab still shows the
// page's title and favicon, cold and once shown again.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, stripTabIds, waitFor, type Crew } from "./harness.ts";

let shared: Crew;
let server: Server;
let origin = "";
/** While set, pages answer this late, so a tab's page takes a while to name itself. */
let delay = 0;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** What a few paths add to their page. */
const PAGES: Record<string, string> = {
  "/form": `<input id="f">`,
  // The page fills its own field and fires input itself, with no person behind it.
  "/scripted": `<input id="f"><script>
    addEventListener("load", () => {
      const f = document.getElementById("f");
      f.focus();
      document.execCommand("insertText", false, "x");
      f.dispatchEvent(new Event("input", { bubbles: true }));
    });
  </script>`,
};

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/icon.png") {
      response.writeHead(200, { "content-type": "image/png" }).end(PNG);
      return;
    }
    const html = `<!doctype html><title>Title ${at}</title><link rel="icon" href="/icon.png"><h1>${at}</h1>${PAGES[at] ?? ""}`;
    setTimeout(() => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html), delay);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  shared = await launchCrew();
});

after(async () => {
  await shared?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/**
 * A strip of these pages as crewd keeps it, brought up by a reload, then each
 * looked at in turn: they come back cold, and looking warms them. The last one
 * stays on screen, and the first is the least recently used. Seeded rather
 * than typed into the launcher, which these specs are not about.
 */
async function seed(crew: Crew, paths: string[]): Promise<string[]> {
  const ids = paths.map((path) => `browser:cold${path.replace(/\//g, "-")}`);
  const tabs = paths.map((path, n) => ({ id: ids[n]!, kind: "browser", url: `${origin}${path}`, title: "" }));
  // A window just launched may still save its own strip over the seed, so the seed goes again until it holds.
  await waitFor(
    async () => {
      await crew.request("state_set", {
        key: `tabs:${crew.workspaces[0]!.id}`,
        value: JSON.stringify({ tabs, activeId: ids[0], recent: [ids[0]] }),
      });
      await crew.window.reload();
      return waitFor(
        async () => {
          const strip = await stripTabIds(crew);
          return ids.every((id) => strip.includes(id));
        },
        { timeout: 5000 },
      ).then(
        () => true,
        () => false,
      );
    },
    { message: "the seeded strip is back", timeout: 30_000 },
  );
  for (const [n, id] of ids.entries()) {
    await crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`).click();
    const url = `${origin}${paths[n]}`;
    await waitFor(async () => (await inPage<boolean>(crew, url, "document.readyState === 'complete'")) === true, {
      message: `${paths[n]} loads`,
    });
  }
  return ids;
}

/** The URLs of pages with a guest up: cold ones have none. */
const liveUrls = (crew: Crew) =>
  crew.app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === "webview")
      .map((w) => w.getURL())
      .sort(),
  );

/** Answers the window's memory pressure question with `level` from now on. */
const pressure = (crew: Crew, level: string) =>
  crew.app.evaluate(({ ipcMain }, answer) => {
    ipcMain.removeHandler("browser:memory-pressure");
    ipcMain.handle("browser:memory-pressure", () => answer);
  }, level);

/** Moves the window's clock ahead, so pages read as unseen that long without the wait. */
const ahead = (crew: Crew, ms: number) =>
  crew.window.evaluate((by) => {
    const w = window as unknown as { realNow?: () => number; ahead?: number };
    w.realNow ??= Date.now.bind(Date);
    w.ahead = (w.ahead ?? 0) + by;
    Date.now = () => w.realNow!() + w.ahead!;
  }, ms);

/** Runs `code` in the live page at `url`; null when it has no guest. */
const inPage = <T>(crew: Crew, url: string, code: string) =>
  crew.app.evaluate(
    ({ webContents }, [target, source]) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getType() === "webview" && w.getURL() === target)
        ?.executeJavaScript(source!) ?? null,
    [url, code],
  ) as Promise<T | null>;

/** Types `text` into the field of the page at `url` as a person does: real key events into the focused field. */
async function typeInto(crew: Crew, url: string, text: string): Promise<void> {
  await crew.app.evaluate(
    async ({ webContents }, [target, keys]) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === target)!;
      guest.focus();
      await guest.executeJavaScript(`document.getElementById("f").focus()`);
      for (const key of keys!) {
        guest.sendInputEvent({ type: "keyDown", keyCode: key });
        guest.sendInputEvent({ type: "char", keyCode: key });
        guest.sendInputEvent({ type: "keyUp", keyCode: key });
      }
    },
    [url, text],
  );
  await waitFor(async () => (await inPage<string>(crew, url, `document.getElementById("f").value`)) === text, {
    message: "the field takes the keys",
  });
}

/** The window sweeps every 30 seconds; this is one sweep with room to spare. */
const SWEEP_WAIT = 40_000;
const MIN = 60_000;

const pill = (id: string) => shared.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);
async function face(id: string) {
  return {
    text: (await pill(id).innerText()).trim(),
    icon: await pill(id).locator("[data-favicon]").count(),
  };
}

test("a cold tab keeps its title and favicon after the window reloads", async () => {
  const first = (await seed(shared, ["/one", "/two"]))[0]!;
  await waitFor(async () => (await face(first)).icon === 1 && (await face(first)).text.includes("Title /one"), {
    message: "first tab shows title and favicon",
  });
  // The tab saves its icon as the page reports it; the reload must not beat the save.
  await waitFor(
    async () => {
      const strip = await shared.request<string | null>("state_get", { key: `tabs:${shared.workspaces[0]!.id}` });
      const saved = strip ? (JSON.parse(strip) as { tabs: { id: string; icon?: string }[] }) : null;
      return Boolean(saved?.tabs.find((tab) => tab.id === first)?.icon);
    },
    { message: "the first tab's icon is saved" },
  );
  // The window's renderer starts over (a relaunch, a reload after sleep): no live page state is left.
  await shared.window.reload();
  await waitFor(async () => (await stripTabIds(shared)).includes(first), { message: "strip back" });
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
  await shared.window.waitForTimeout(delay + 1000);
  // The pill shows a spinner in the icon's place while the page loads, and the
  // title can come back before it finishes: the icon is waited for, not sampled.
  await waitFor(async () => (await face(first)).icon === 1, { message: "the favicon comes back" });
  delay = 0;
  const seen = await shared.window.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const lost = seen.filter((text) => !text.includes("Title /one"));
  assert.deepEqual(lost, [], `the title flickered while the page mounted: ${JSON.stringify(seen)}`);
  const after = await face(first);
  assert.ok(after.text.includes("Title /one"), `title lost: ${JSON.stringify(after)}`);
  assert.equal(after.icon, 1, `favicon lost: ${JSON.stringify(after)}`);
});

test("hidden pages stay live however long unseen while memory is fine or only moderately short", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  // More than the old budget of six hidden pages.
  await seed(crew, Array.from({ length: 8 }, (_, i) => `/live${i}`));
  await waitFor(async () => (await liveUrls(crew)).length === 8, { message: "every page keeps its guest" });
  // A day unseen, the old hour many times over.
  await ahead(crew, 24 * 60 * MIN);
  await pressure(crew, "moderate");
  await crew.window.waitForTimeout(SWEEP_WAIT);
  assert.equal((await liveUrls(crew)).length, 8, "no page went cold");
});

test("under critical memory hidden pages go one a sweep, least recently used first", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  await seed(crew, ["/a", "/b", "/c", "/d"]);
  await waitFor(async () => (await liveUrls(crew)).length === 4, { message: "every page keeps its guest" });
  // Past the grace a page just looked at gets.
  await ahead(crew, 10 * MIN);
  await pressure(crew, "critical");
  const all = [`${origin}/a`, `${origin}/b`, `${origin}/c`, `${origin}/d`];
  await waitFor(async () => (await liveUrls(crew)).length < 4, { message: "one page goes", timeout: SWEEP_WAIT });
  assert.deepEqual(await liveUrls(crew), all.slice(1), "the least recently used page went, alone");
  await waitFor(async () => (await liveUrls(crew)).length < 3, { message: "the next goes", timeout: SWEEP_WAIT });
  assert.deepEqual(await liveUrls(crew), all.slice(2), "then the next least recently used");
  await pressure(crew, "normal");
  await crew.window.waitForTimeout(SWEEP_WAIT);
  assert.deepEqual(await liveUrls(crew), all.slice(2), "nothing more goes once memory is fine");
});

test("a page with a half-filled form stays live under critical memory until it loads again", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const form = `${origin}/form`;
  const scripted = `${origin}/scripted`;
  const [formTab, scriptedTab, plainTab] = await seed(crew, ["/form", "/scripted", "/plain"]);
  const show = (id: string | undefined) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`).click();
  await show(formTab);
  await typeInto(crew, form, "hi");
  // Then the page that fills itself, and a plain one left on screen: the form is the least recently used.
  await show(scriptedTab);
  await show(plainTab);
  await waitFor(async () => (await inPage<string>(crew, scripted, `document.getElementById("f").value`)) === "x", {
    message: "the page fills its own field",
  });
  await ahead(crew, 10 * MIN);
  await pressure(crew, "critical");
  // The form was hidden first, so it would go first: it is passed over, and the scripted page goes.
  await waitFor(async () => !(await liveUrls(crew)).includes(scripted), {
    message: "the page that filled itself goes",
    timeout: SWEEP_WAIT,
  });
  await crew.window.waitForTimeout(SWEEP_WAIT);
  assert.deepEqual(await liveUrls(crew), [form, `${origin}/plain`], "the form and the page on screen stay");
  assert.equal(await inPage(crew, form, `document.getElementById("f").value`), "hi", "what was typed is still there");

  // A reload is a new document with nothing typed: the page can go again, once past its grace.
  await crew.app.evaluate(({ webContents }, target) => {
    webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === target)!.reload();
  }, form);
  await crew.window.waitForTimeout(SWEEP_WAIT);
  await ahead(crew, 10 * MIN);
  await waitFor(async () => !(await liveUrls(crew)).includes(form), { message: "the reloaded form goes", timeout: SWEEP_WAIT });
  await pressure(crew, "normal");
});

test("a page whose renderer crashed after a form was typed into stops holding its guest", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const form = `${origin}/form`;
  const [formTab, plainTab] = await seed(crew, ["/form", "/plain"]);
  const show = (id: string | undefined) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`).click();
  const crash = () =>
    crew.app.evaluate(({ webContents }, target) => {
      webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === target)!.forcefullyCrashRenderer();
    }, form);
  const loaded = () => waitFor(async () => (await inPage(crew, form, "document.readyState === 'complete'")) === true, { message: "the form loads" });
  await show(formTab);
  // The first crash is retried with a reload, a new document; the second is left as it is.
  await typeInto(crew, form, "hi");
  await crash();
  await crew.window.waitForTimeout(1000);
  await loaded();
  await typeInto(crew, form, "hi");
  await crash();
  await crew.window.waitForTimeout(1000);
  await show(plainTab);
  await ahead(crew, 10 * MIN);
  await pressure(crew, "critical");
  // Nothing typed is left in a dead renderer, so the page goes like any other.
  await waitFor(async () => !(await liveUrls(crew)).includes(form), { message: "the crashed page goes cold", timeout: SWEEP_WAIT });
  await pressure(crew, "normal");
});

test("going back loads the page anew, so a form mark never outlives its document", async (t) => {
  // Electron's guests keep no back/forward cache. Were one to come, a page
  // restored from it would keep what was typed but not its mark, since every
  // committed navigation clears it; this is where that would show.
  const crew = await launchCrew();
  t.after(() => crew.close());
  const form = `${origin}/form`;
  await seed(crew, ["/form"]);
  await crew.app.evaluate(async ({ webContents }, [target, next]) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL() === target)!;
    await guest.executeJavaScript(`window.__same = true`);
    await guest.loadURL(next!);
    guest.navigationHistory.goBack();
  }, [form, `${origin}/plain`]);
  await waitFor(async () => (await inPage(crew, form, "document.readyState === 'complete'")) === true, { message: "the form is back" });
  assert.equal(await inPage(crew, form, "window.__same ?? null"), null, "the document came back from a back/forward cache");
});
