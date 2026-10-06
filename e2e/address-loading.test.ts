// The address bar while a page is on its way: it shows where the page is
// going, not where it was (or nothing), and goes back to the page's own
// address once the load is over. A local server holds `/slow/*` pages until
// the test lets them go.
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
const held: ServerResponse[] = [];

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (at.startsWith("/slow/")) held.push(response);
    else response.end(`<!doctype html><title>${at}</title><h1>${at}</h1>`);
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

/** Lets every held page finish. */
function release(): void {
  for (const response of held.splice(0)) response.end("<!doctype html><title>slow</title><h1>slow</h1>");
}

const address = () => crew.window.getByLabel("Address", { exact: true }).locator("visible=true");

async function waitForAddress(expected: string, message: string): Promise<void> {
  await waitFor(async () => (await address().inputValue().catch(() => null)) === expected, {
    message: `${message} (the bar says "${await address().inputValue().catch(() => "?")}")`,
  });
}

async function newTab(url: string): Promise<void> {
  const before = (await stripTabIds(crew)).length;
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
}

async function typeAddress(url: string): Promise<void> {
  await address().click();
  await address().fill(url);
  await crew.window.keyboard.press("Enter");
}

test("a tab opened at a slow page shows its address while it loads", async () => {
  const slow = `${origin}/slow/opened`;
  await newTab(slow);
  await waitFor(() => held.length > 0, { message: "the page is asked for" });
  await waitForAddress(slow, "the bar shows the page on its way");
  release();
  await waitForAddress(slow, "the bar shows the loaded page");
});

test("an address typed over a loaded page shows while it loads", async () => {
  const first = `${origin}/first`;
  const second = `${origin}/slow/second`;
  await typeAddress(first);
  await waitForAddress(first, "the first page loads");
  await typeAddress(second);
  await waitFor(() => held.length > 0, { message: "the second page is asked for" });
  await waitForAddress(second, "the bar shows the second page on its way");
  // It stays: nothing the old page or the guest reports puts the first one back.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await address().inputValue(), second);
  release();
  await waitForAddress(second, "the bar shows the second page once it loads");
});

test("stopping a load puts the page's own address back", async () => {
  const first = `${origin}/stays`;
  const second = `${origin}/slow/stopped`;
  await typeAddress(first);
  await waitForAddress(first, "the page loads");
  await typeAddress(second);
  await waitFor(() => held.length > 0, { message: "the second page is asked for" });
  await waitForAddress(second, "the bar shows the page on its way");
  await crew.window.getByRole("button", { name: "Stop" }).click();
  await waitForAddress(first, "the bar goes back to the page that is still shown");
  release();
});
