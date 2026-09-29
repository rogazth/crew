// A page past the retention budget goes cold and comes back from its saved
// stack. With the window's live page state gone (a reload, a reopened window),
// its tab still shows the page's title and favicon, cold and once shown again.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
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
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Title ${at}</title><link rel="icon" href="/icon.png"><h1>${at}</h1>`);
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
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before.length, { message: "a browser tab opens" });
  return (await stripTabIds(crew)).find((tab) => !before.includes(tab))!;
}

const pill = (id: string) => crew.window.locator(`[data-tab-strip] [role="tab"][data-tab-id="${id}"]`);
async function face(id: string) {
  return {
    text: (await pill(id).innerText()).trim(),
    icon: await pill(id).locator("img").count(),
  };
}

test("a cold tab keeps its title and favicon after the window reloads", async () => {
  const first = await openPage(`${origin}/one`);
  await waitFor(async () => (await face(first)).icon === 1 && (await face(first)).text.includes("Title /one"), {
    message: "first tab shows title and favicon",
  });
  // Seven more tabs push the first one past the retention budget (6).
  for (let i = 0; i < 7; i++) await openPage(`${origin}/p${i}`);
  // The window's renderer starts over (a relaunch, a reload after sleep): no live page state is left.
  await crew.window.reload();
  await waitFor(async () => (await stripTabIds(crew)).includes(first), { message: "strip back" });
  await waitFor(async () => (await face(first)).icon === 1, { message: "the cold tab shows its saved favicon" });
  await pill(first).click();
  await waitFor(async () => (await face(first)).text.includes("Title /one"), { message: "the title comes back" });
  // The pill shows a spinner in the icon's place while the page loads, and the
  // title can come back before it finishes: the icon is waited for, not sampled.
  await waitFor(async () => (await face(first)).icon === 1, { message: "the favicon comes back" });
  const after = await face(first);
  assert.ok(after.text.includes("Title /one"), `title lost: ${JSON.stringify(after)}`);
  assert.equal(after.icon, 1, `favicon lost: ${JSON.stringify(after)}`);
});
