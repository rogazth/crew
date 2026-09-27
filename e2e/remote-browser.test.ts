// A remote workspace's pages open the machine's loopback: `localhost:<port>`
// there goes through a relay on this Mac to the SOCKS proxy beside the
// machine's `crewd serve`, which is what makes a dev server on a VPS open in
// Crew. Here the machine is a second crewd on this loopback, so a page that
// loads proves nothing by itself; the machine going away does: its pages stop
// loading while this Mac's workspace keeps opening the same server, and they
// load again once it is back. A dev server's HMR websocket rides the same way.
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
 * with what comes down it; every other path is a page titled by its path.
 */
async function devServer(): Promise<{ port: number; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const at = new URL(request.url ?? "/", "http://localhost").pathname;
    if (at === "/favicon.ico") return void response.writeHead(404).end();
    requests.push(at);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

/** How a workspace's pages would reach `url`, as its session's proxy settles it. */
function route(crew: Crew, workspaceId: string, url: string): Promise<string> {
  return crew.app.evaluate(
    ({ session }, [partition, target]) => session.fromPartition(partition!).resolveProxy(target!),
    [partitionFor(workspaceId), url],
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

/** The title of the page in `workspaceId`'s session showing `url`, once it has one. */
function pageTitle(crew: Crew, workspaceId: string, url: string): Promise<string | null> {
  return crew.app.evaluate(
    ({ webContents, session }, [partition, target]) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === target && wc.session === session.fromPartition(partition!));
      return guest && !guest.isLoading() ? guest.getTitle() : null;
    },
    [partitionFor(workspaceId), url],
  );
}

test("a remote workspace's pages open the machine's localhost, websockets too, and only while it answers", async () => {
  const crew = await launchCrew();
  const dev = await devServer();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const local = crew.workspaces[0]!;
    const web = await crew.makeRepo("web");
    const workspace = await remoteRequest<Workspace>(remote, "workspace_create", { name: "web", path: web });
    await crew.reload();
    await mark(crew, "web").waitFor({ timeout: 15_000 });

    // Every host in the remote workspace goes to the relay (which dials the rest from here); this Mac's workspace goes direct.
    await waitFor(async () => (await route(crew, workspace.id, "http://localhost:3000/")).startsWith("PROXY 127.0.0.1:"), {
      message: "the remote workspace's session routes localhost through the relay",
      timeout: 15_000,
    });
    const relay = await route(crew, workspace.id, "http://localhost:3000/");
    assert.equal(await route(crew, workspace.id, "http://127.0.0.1:3000/"), relay);
    assert.equal(await route(crew, workspace.id, "http://[::1]:3000/"), relay);
    assert.equal(await route(crew, workspace.id, "https://example.com/"), relay);
    assert.equal(await route(crew, local.id, "http://localhost:3000/"), "DIRECT");

    // A dev server page and its HMR socket, through the machine.
    await mark(crew, "web").click();
    const page = `http://localhost:${dev.port}/page`;
    await openPage(crew, page);
    await waitFor(async () => (await pageTitle(crew, workspace.id, page)) === "hmr ok", {
      message: "the page loads through the machine and its websocket answers",
      timeout: 15_000,
    });
    assert.deepEqual(dev.requests, ["/page", "/hmr"]);

    // By IP as well.
    const byIp = `http://127.0.0.1:${dev.port}/by-ip`;
    await openPage(crew, byIp);
    await waitFor(async () => (await pageTitle(crew, workspace.id, byIp)) === "/by-ip", { message: "127.0.0.1 loads too" });

    // The machine goes away: its pages cannot reach the dev server, this Mac's still can.
    await remote.stop();
    const gone = `http://localhost:${dev.port}/while-gone`;
    await openPage(crew, gone);
    await waitFor(async () => (await pageTitle(crew, workspace.id, gone)) !== null, { message: "the page settles" });
    assert.ok(!dev.requests.includes("/while-gone"), "nothing reached the dev server without the machine");

    await mark(crew, "app").click();
    const direct = `http://localhost:${dev.port}/from-mac`;
    await openPage(crew, direct);
    await waitFor(async () => (await pageTitle(crew, local.id, direct)) === "/from-mac", { message: "this Mac's workspace loads direct" });

    // It comes back: the remote workspace's pages load again.
    await remote.start();
    await waitFor(
      async () => (await mark(crew, "web").locator("[data-remote-badge]").getAttribute("data-remote-badge", { timeout: 1_000 })) === "online",
      { message: "the machine answers again", timeout: 20_000 },
    );
    await mark(crew, "web").click();
    const back = `http://localhost:${dev.port}/back`;
    await openPage(crew, back);
    await waitFor(async () => (await pageTitle(crew, workspace.id, back)) === "/back", { message: "pages load once the machine is back" });
  } finally {
    await remote?.stop();
    await crew.close();
    dev.server.closeAllConnections();
    dev.server.close();
  }
});

test("two workspaces on one machine share its relay, and one leaving goes back to direct without breaking the other", async () => {
  const crew = await launchCrew();
  const dev = await devServer();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const web = await remoteRequest<Workspace>(remote, "workspace_create", { name: "web", path: await crew.makeRepo("web") });
    const api = await remoteRequest<Workspace>(remote, "workspace_create", { name: "api", path: await crew.makeRepo("api") });
    await crew.reload();
    await mark(crew, "api").waitFor({ timeout: 15_000 });

    const proxied = async (id: string) => (await route(crew, id, "http://localhost:3000/")).startsWith("PROXY 127.0.0.1:");
    await waitFor(async () => (await proxied(web.id)) && (await proxied(api.id)), {
      message: "both workspaces route through a relay",
      timeout: 15_000,
    });
    assert.equal(await route(crew, web.id, "http://localhost:3000/"), await route(crew, api.id, "http://localhost:3000/"), "one relay per machine");

    // `api` goes away on the machine: its session is direct again, `web` keeps the relay and loads.
    await remoteRequest(remote, "workspace_delete", { id: api.id });
    await crew.reload();
    await mark(crew, "api").waitFor({ state: "detached", timeout: 15_000 });
    await waitFor(async () => (await route(crew, api.id, "http://localhost:3000/")) === "DIRECT", {
      message: "the removed workspace's session goes direct",
      timeout: 15_000,
    });
    assert.ok(await proxied(web.id));
    await mark(crew, "web").click();
    const page = `http://localhost:${dev.port}/still-here`;
    await openPage(crew, page);
    await waitFor(async () => (await pageTitle(crew, web.id, page)) === "/still-here", { message: "the other workspace still loads" });
  } finally {
    await remote?.stop();
    await crew.close();
    dev.server.closeAllConnections();
    dev.server.close();
  }
});
