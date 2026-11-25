// A tab spins for its own page, not for a frame inside it: a widget that
// loads its frame again on its own (a captcha, an ad) must not blink the tab.
// A local server holds `/slow/*` responses until the test lets them go.
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { holdsFor, launchCrew, openAddress, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let server: Server;
let origin = "";
const held = new Map<string, ServerResponse>();

before(async () => {
  server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (at === "/favicon.ico") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (at.startsWith("/slow/")) held.set(at, response);
    else if (at === "/host") response.end(`<!doctype html><title>Host</title><h1>Host</h1><iframe src="/frame"></iframe>`);
    else response.end(`<!doctype html><title>${at}</title><p>${at}</p>`);
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

function release(path: string): void {
  held.get(path)?.end(`<!doctype html><title>${path}</title><p>${path}</p>`);
  held.delete(path);
}

function inGuest<T = unknown>(code: string): Promise<T> {
  return crew.app.evaluate(
    async ({ webContents }, [origin, source]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getURL().startsWith(origin!));
      return guest ? guest.executeJavaScript(source!, true) : null;
    },
    [origin, code],
  ) as Promise<T>;
}

const spinning = () => crew.window.locator('[data-tab-strip] [role="tab"][data-tab-id^="browser:"] .animate-spin').count();

test("a frame loading again leaves the tab still; the page's own load spins it", async () => {
  await openAddress(crew, `${origin}/host`);
  await waitFor(async () => (await inGuest<string>("document.title")) === "Host", { message: "the host page loads" });
  await waitFor(async () => (await spinning()) === 0, { message: "the tab stops spinning once the page is in" });

  await inGuest(`document.querySelector("iframe").src = "/slow/frame"`);
  await waitFor(() => held.has("/slow/frame"), { message: "the frame asks again" });
  await holdsFor(1500, async () => (await spinning()) === 0, "the tab spins for a frame's load");

  // A navigation of the page while its frame still loads gets no start of its own from Chromium.
  await inGuest(`location.href = "/slow/next"`);
  await waitFor(() => held.has("/slow/next"), { message: "the page asks for the next one" });
  await waitFor(async () => (await spinning()) === 1, { message: "the tab spins for the page's own load" });
  release("/slow/frame");
  release("/slow/next");
  await waitFor(async () => (await spinning()) === 0, { message: "the tab stops once the page is in" });
  assert.equal(await inGuest<string>("document.title"), "/slow/next");
});
