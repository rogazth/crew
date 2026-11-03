// The address bar's suggestions: the one under the pointer shows its address
// in the bar, and leaving the list puts back what was typed.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { launchCrew, stripTabIds, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Page ${at}</title><h1>${at}</h1>`);
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

const address = () => crew.window.getByLabel("Address", { exact: true }).locator("visible=true");

async function waitForAddress(expected: string, message: string): Promise<void> {
  await waitFor(async () => (await address().inputValue().catch(() => null)) === expected, {
    message: `${message} (the bar says "${await address().inputValue().catch(() => "?")}")`,
  });
}

async function typeAddress(url: string): Promise<void> {
  await address().click();
  await address().fill(url);
  await address().dispatchEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
}

test("hovering a suggestion shows its address in the bar", async () => {
  const before = (await stripTabIds(crew)).length;
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(`${origin}/first`);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
  await waitForAddress(`${origin}/first`, "the first page loads");
  await typeAddress(`${origin}/visited`);
  await waitForAddress(`${origin}/visited`, "the second page loads");

  await address().click();
  await address().fill("127.0.0.1");
  // By its address: the page's title may not be in the history yet.
  const option = crew.window.getByRole("option", { name: /\/first/ });
  await waitFor(() => option.isVisible(), { message: "history offers the first page" });
  // The first move over a row only says where the pointer is: rows appear under a still one.
  await option.hover();
  const box = await option.boundingBox();
  assert.ok(box);
  await crew.window.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
  await waitForAddress(`${origin}/first`, "the hovered suggestion shows in the bar");
  await crew.window.mouse.move(0, 0);
  await waitForAddress("127.0.0.1", "leaving the list puts back what was typed");
});
