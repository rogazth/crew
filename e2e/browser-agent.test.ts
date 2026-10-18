// B1: a browser tab driven through crewd's relay, the way an agent's tools
// will reach it. `browser_tool` runs a tool as the user; the call travels
// crewd → Electron main → the tab's guest and back. open_tab makes a tab
// behind the one on screen, so every step below drives a page nobody is
// looking at: the path an agent takes while the user works elsewhere.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { BrowserLeases } from "../src/lib/protocol.ts";
import { launchCrew, savedStrip, waitFor } from "./harness.ts";

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const FORM = `<!doctype html><title>Order</title>
<h1>Order</h1>
<label>Email <input id="email" value="old@example.com"></label>
<label>Size <select id="size"><option>S</option><option>L</option></select></label>
<button onclick="document.title = 'Sent ' + email.value + ' ' + size.value">Send</button>`;

test("B1: a tab opened, read, filled, clicked and captured through the relay", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/order`;

  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tool = (name: string, args: object = {}) =>
    crew.request<Block[]>("browser_tool", { workspaceId: workspace.id, tool: name, args });
  const text = (blocks: Block[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");

  // Main registers as the browser host on its own connection; until then the call says to open Crew.
  const opened = await waitFor(() => tool("open_tab", { url }).catch(() => null), {
    timeout: 30_000,
    interval: 250,
    message: "open_tab reaches the browser host",
  });
  const tab = /Opened (browser:\S+)/.exec(text(opened))?.[1];
  assert.ok(tab, text(opened));

  // It joins the workspace's strip, behind the tab on screen, and is saved with it.
  const strip = await waitFor(async () => {
    const saved = await savedStrip(crew, workspace.id);
    return saved?.ids.includes(tab) ? saved : null;
  }, { message: "the new tab is in the saved strip" });
  assert.notEqual(strip.activeId, tab);

  // Held by whoever opened it, and the tab says so.
  const leases = await crew.request<BrowserLeases>("browser_leases_list");
  assert.deepEqual(leases.leases.map((lease) => [lease.tab, lease.holder]), [[tab, "you"]]);

  const snapshot = text(await tool("browser_snapshot"));
  const uid = (pattern: RegExp) => {
    const found = pattern.exec(snapshot)?.[1];
    assert.ok(found, `${pattern} in:\n${snapshot}`);
    return found;
  };
  assert.match(snapshot, /heading "Order" level=1/);

  await tool("browser_act", { action: "fill", uid: uid(/uid=(\S+) textbox "Email"/), value: "ada@example.com" });
  await tool("browser_act", { action: "fill", uid: uid(/uid=(\S+) combobox "Size"/), value: "L" });
  await tool("browser_act", { action: "click", uid: uid(/uid=(\S+) button "Send"/) });
  const title = text(await tool("browser_evaluate", { expression: "document.title" }));
  assert.equal(title, '"Sent ada@example.com L"');

  // An old uid is refused once the page has been read again.
  await tool("browser_snapshot");
  await assert.rejects(tool("browser_act", { action: "click", uid: uid(/uid=(\S+) button "Send"/) }), /Take a new snapshot/);

  const [shot] = await tool("browser_screenshot");
  assert.equal(shot?.type, "image");
  assert.ok(shot.type === "image" && Buffer.from(shot.data, "base64").subarray(1, 4).toString() === "PNG");

  // Taking it back frees the tab.
  await crew.request("browser_lease_release", { tab });
  await waitFor(async () => (await crew.request<BrowserLeases>("browser_leases_list")).leases.length === 0, {
    message: "the lease is gone",
  });
});

// The page and a cross-origin iframe in it see Google Chrome, the way the
// requests name it, and the agent still reads the console without the
// debugger's Runtime domain, which pages can detect.
test("B2: a page and its cross-origin iframe see Google Chrome, and the console still reaches the agent", async (t) => {
  const frame = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><script>
      parent.postMessage({
        brands: navigator.userAgentData.brands.map((b) => b.brand),
        chrome: typeof window.chrome?.loadTimes,
      }, "*");
      setTimeout(() => console.log("frame-log"), 300);
    </script>`);
  });
  await new Promise<void>((resolve) => frame.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => frame.close(() => resolve())));
  // localhost against 127.0.0.1: another site, so the frame runs in its own process.
  const frameUrl = `http://localhost:${(frame.address() as AddressInfo).port}/frame`;
  const page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Host</title>
      <script>addEventListener("message", (e) => { window.fromFrame = e.data; });</script>
      <iframe src="${frameUrl}"></iframe>`);
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => page.close(() => resolve())));
  const url = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`;

  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tool = (name: string, args: object = {}) =>
    crew.request<Block[]>("browser_tool", { workspaceId: workspace.id, tool: name, args });
  const text = (blocks: Block[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  await waitFor(() => tool("open_tab", { url }).catch(() => null), {
    timeout: 30_000,
    interval: 250,
    message: "open_tab reaches the browser host",
  });

  const top = JSON.parse(
    text(
      await tool("browser_evaluate", {
        expression: "({ brands: navigator.userAgentData.brands.map((b) => b.brand), chrome: typeof window.chrome?.loadTimes })",
      }),
    ),
  );
  assert.ok(top.brands.includes("Google Chrome"), JSON.stringify(top));
  assert.equal(top.chrome, "function");
  // navigator.webdriver is not checked: Playwright starts Electron with
  // --remote-debugging-port, which alone makes it true. The app as it ships
  // has it false, with the agent's debugger attached too.

  const inFrame = await waitFor(
    async () => {
      const value = text(await tool("browser_evaluate", { expression: "window.fromFrame ?? null" }));
      return value === "null" ? null : JSON.parse(value);
    },
    { timeout: 15_000, message: "the iframe reports what it sees" },
  );
  assert.ok(inFrame.brands.includes("Google Chrome"), JSON.stringify(inFrame));
  assert.equal(inFrame.chrome, "function");

  await tool("browser_evaluate", {
    expression: "console.log('top-log'); console.warn('top-warn'); setTimeout(() => { throw new Error('top-uncaught'); }, 0); 1",
  });
  const log = await waitFor(
    async () => {
      const lines = text(await tool("browser_activity", { kind: "console" }));
      return ["top-log", "top-warn", "top-uncaught", "frame-log"].every((word) => lines.includes(word)) ? lines : null;
    },
    { timeout: 15_000, message: "console lines, an uncaught error and the iframe's log reach the agent" },
  );
  assert.match(log, /top-uncaught/);
});
