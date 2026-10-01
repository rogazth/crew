// A remote workspace's pages open the machine's loopback: `localhost:<port>`
// there becomes `<machine>.localhost:<port>`, which goes through a relay on
// this Mac to the SOCKS proxy beside the machine's `crewd serve`, which is
// what makes a dev server on a VPS open in Crew. Every page shares one
// session, so the machine is in the name, not in the session. Here the
// machine is a second crewd on this loopback, so a page that loads proves
// nothing by itself; the machine going away does: its pages stop loading
// while this Mac's workspace keeps opening the same server, and they load
// again once it is back. A dev server's HMR websocket rides the same way.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Workspace } from "../src/lib/types.ts";
import { partitionFor } from "../src/lib/browser/bridge.ts";
import { addRemote, launchCrew, remoteRequest, stripTabIds, waitFor, type Crew, type RemoteDaemon } from "./harness.ts";

/**
 * A dev server: `/page` opens a websocket back to itself and titles itself
 * with what comes down it; `/sw-page` installs `/sw.js`, which fetches
 * `/from-sw` on its own; every other path is a page titled by its path.
 */
async function devServer(): Promise<{ port: number; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://localhost").pathname;
    if (at === "/favicon.ico") return void response.writeHead(404).end();
    requests.push(at);
    if (at === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(`self.addEventListener("install", (event) => event.waitUntil(fetch("/from-sw")));`);
      return;
    }
    if (at === "/api") {
      response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      response.end(request.headers["x-crew-machine"] ? "machine header leaked" : "api ok");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (at === "/fetch-page") {
      // The page's code spells out plain localhost, as a VITE_API_URL would.
      response.end(`<!doctype html><title>fetching</title><script>
        window.hit = () => fetch("http://localhost:" + location.port + "/api").then((r) => r.text()).then(
          (text) => { document.title = text; }, () => { document.title = "fetch failed"; });
        hit();
      </script>`);
      return;
    }
    if (at === "/sw-page") {
      response.end(`<!doctype html><title>registering</title><script>
        navigator.serviceWorker.register("/sw.js").then(
          (reg) => { const sw = reg.installing ?? reg.waiting ?? reg.active; const done = () => { document.title = "sw " + sw.state; };
            sw.state === "installing" ? sw.addEventListener("statechange", done) : done(); },
          (error) => { document.title = "sw failed " + error; },
        );
      </script>`);
      return;
    }
    if (at === "/page") {
      response.end(`<!doctype html><title>waiting</title><script>
        const ws = new WebSocket("ws://" + location.host + "/hmr");
        ws.onmessage = (event) => { document.title = event.data; };
        ws.onerror = () => { document.title = "ws failed"; };
      </script>`);
      return;
    }
    response.end(`<!doctype html><title>${at}</title><h1>${at}</h1>`);
  });
  // The smallest websocket: the handshake, then one unmasked text frame.
  server.on("upgrade", (request, socket) => {
    requests.push(new URL(request.url ?? "/", "http://localhost").pathname);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = Buffer.from("hmr ok");
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests, server };
}

function mark(crew: Crew, name: string) {
  return crew.window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="${name}"]`);
}

/** How pages would reach `url`, as their session's proxy settles it; `incognito` asks the in-memory one. */
function route(crew: Crew, url: string, incognito = false): Promise<string> {
  return crew.app.evaluate(
    ({ session }, [partition, target]) => session.fromPartition(partition!).resolveProxy(target!),
    [partitionFor(incognito), url],
  );
}

/** Opens `url` in a new tab of the workspace on screen, from the strip's + (a page may hold the keyboard). */
async function openPage(crew: Crew, url: string): Promise<void> {
  const before = (await stripTabIds(crew)).length;
  await crew.window.getByRole("button", { name: /^New tab/ }).first().click();
  const field = crew.window.getByRole("combobox", { name: "Open a tab" }).or(crew.window.getByLabel("Open a tab"));
  await field.first().fill(url);
  await crew.window.keyboard.press("Enter");
  await waitFor(async () => (await stripTabIds(crew)).length > before, { message: "a browser tab opens" });
}

/** The page showing `url`, once it has loaded. */
function guestShowing(crew: Crew, url: string): Promise<number | null> {
  return crew.app.evaluate(
    ({ webContents, session }, [partition, target]) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === target && wc.session === session.fromPartition(partition!));
      return guest && !guest.isLoading() ? guest.id : null;
    },
    [partitionFor(), url],
  );
}

/** The title of the page showing `url`, once it has one. */
async function pageTitle(crew: Crew, url: string): Promise<string | null> {
  const id = await guestShowing(crew, url);
  if (id === null) return null;
  return crew.app.evaluate(({ webContents }, guest) => webContents.fromId(guest)?.getTitle() ?? null, id);
}

/** Runs `script` in the page showing `url`. */
async function inPage(crew: Crew, url: string, script: string): Promise<void> {
  const id = await guestShowing(crew, url);
  assert.ok(id !== null, `a page shows ${url}`);
  await crew.app.evaluate(({ webContents }, [guest, code]) => webContents.fromId(guest as number)?.executeJavaScript(code as string), [id, script] as const);
}

test("a remote workspace's pages open the machine's localhost at its name, websockets too, and only while it answers", async () => {
  const crew = await launchCrew();
  const dev = await devServer();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const web = await crew.makeRepo("web");
    await remoteRequest<Workspace>(remote, "workspace_create", { name: "web", path: web });
    await crew.reload();
    await mark(crew, "web").waitFor({ timeout: 15_000 });

    // Once a machine is known, every page's loopback goes to the relay; names that cannot be loopback skip it.
    await waitFor(async () => (await route(crew, "http://localhost:3000/")).startsWith("PROXY 127.0.0.1:"), {
      message: "the pages' session routes loopback through the relay",
      timeout: 15_000,
    });
    const relay = await route(crew, "http://localhost:3000/");
    assert.equal(await route(crew, "http://127.0.0.1:3000/"), relay);
    assert.equal(await route(crew, "http://[::1]:3000/"), relay);
    assert.equal(await route(crew, "http://devbox.localhost:3000/"), relay);
    assert.equal(await route(crew, "http://devbox:3000/"), relay, "a single-label name may be loopback: the relay decides");
    assert.equal(await route(crew, "https://example.com/"), "DIRECT");
    assert.equal(await route(crew, "https://github.io/"), "DIRECT");
    assert.equal(await route(crew, "http://10.0.0.1/"), "DIRECT");
    // Incognito pages reach the machine the same way.
    assert.equal(await route(crew, "http://devbox.localhost:3000/", true), relay);
    assert.equal(await route(crew, "https://example.com/", true), "DIRECT");

    // Typed as the terminal prints it, a dev server page opens at the machine's name, and its HMR socket follows.
    await mark(crew, "web").click();
    await openPage(crew, `http://localhost:${dev.port}/page`);
    const page = `http://devbox.localhost:${dev.port}/page`;
    await waitFor(async () => (await pageTitle(crew, page)) === "hmr ok", {
      message: "the page loads through the machine and its websocket answers",
      timeout: 15_000,
    });
    assert.deepEqual(dev.requests, ["/page", "/hmr"]);

    // By IP as well.
    await openPage(crew, `http://127.0.0.1:${dev.port}/by-ip`);
    await waitFor(async () => (await pageTitle(crew, `http://devbox.localhost:${dev.port}/by-ip`)) === "/by-ip", {
      message: "127.0.0.1 opens at the machine's name too",
    });

    // A fetch the page's code aims at plain localhost goes to the machine, and the relay keeps the header to itself.
    await openPage(crew, `http://localhost:${dev.port}/fetch-page`);
    const fetching = `http://devbox.localhost:${dev.port}/fetch-page`;
    await waitFor(async () => (await pageTitle(crew, fetching)) === "api ok", { message: "the page's own localhost fetch answers" });

    // A service worker's own fetches ride the relay too.
    await openPage(crew, `http://localhost:${dev.port}/sw-page`);
    const swPage = `http://devbox.localhost:${dev.port}/sw-page`;
    await waitFor(async () => /^sw (installed|activating|activated)$/.test((await pageTitle(crew, swPage)) ?? ""), {
      message: "the service worker installs",
    });
    assert.ok(dev.requests.includes("/from-sw"), "the worker's fetch reached the dev server");

    // The machine goes away: its pages cannot reach the dev server, not even through their code's plain localhost.
    await remote.stop();
    await openPage(crew, `http://localhost:${dev.port}/while-gone`);
    await waitFor(async () => (await guestShowing(crew, `http://devbox.localhost:${dev.port}/while-gone`)) !== null, {
      message: "the page settles",
    });
    assert.ok(!dev.requests.includes("/while-gone"), "nothing reached the dev server without the machine");
    const apiHits = dev.requests.filter((at) => at === "/api").length;
    await mark(crew, "web").click();
    await inPage(crew, fetching, "hit()");
    await waitFor(async () => (await pageTitle(crew, fetching)) === "fetch failed", { message: "the page's own fetch fails with the machine" });
    assert.equal(dev.requests.filter((at) => at === "/api").length, apiHits);

    // This Mac's workspace opens the same server at plain localhost, relay or not.
    await mark(crew, "app").click();
    const direct = `http://localhost:${dev.port}/from-mac`;
    await openPage(crew, direct);
    await waitFor(async () => (await pageTitle(crew, direct)) === "/from-mac", { message: "this Mac's workspace loads its own localhost" });

    // It comes back: the remote workspace's pages load again.
    await remote.start();
    await waitFor(
      async () => (await mark(crew, "web").locator("[data-remote-badge]").getAttribute("data-remote-badge", { timeout: 1_000 })) === "online",
      { message: "the machine answers again", timeout: 20_000 },
    );
    await mark(crew, "web").click();
    await openPage(crew, `http://localhost:${dev.port}/back`);
    await waitFor(async () => (await pageTitle(crew, `http://devbox.localhost:${dev.port}/back`)) === "/back", {
      message: "pages load once the machine is back",
    });
  } finally {
    await remote?.stop();
    await crew.close();
    dev.server.closeAllConnections();
    dev.server.close();
  }
});
