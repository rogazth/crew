// An agent on a remote machine drives the tabs of its workspace, which live
// in this Mac's browser: the call goes remote crewd → this Mac's main (its
// link to that machine) → the tab's guest and back. The machine only reaches
// its own workspace's tabs, says why when no Mac is there, and picks up again
// when it restarts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { BrowserLeases, Workspace } from "../src/lib/protocol.ts";
import { addRemote, launchCrew, remoteRequest, savedStrip, waitFor, type RemoteDaemon } from "./harness.ts";

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const FORM = `<!doctype html><title>Order</title>
<h1>Order</h1>
<label>Email <input id="email" value="old@example.com"></label>
<button onclick="document.title = 'Sent ' + email.value">Send</button>`;

/** A browser tool run on the machine as the user, waiting as long as a page load may take. */
function remoteTool(remote: RemoteDaemon, workspaceId: string, tool: string, args: object = {}): Promise<Block[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${remote.port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${tool}: no answer`));
    }, 70_000);
    ws.onopen = () => ws.send(JSON.stringify({ auth: remote.token }));
    ws.onerror = () => reject(new Error(`${tool}: could not connect`));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { event?: string; id?: number; ok?: boolean; result?: Block[]; error?: string };
      if (message.event === "hello") ws.send(JSON.stringify({ id: 1, method: "browser_tool", params: { workspaceId, tool, args } }));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.ok) resolve(message.result ?? []);
      else reject(new Error(message.error ?? tool));
    };
  });
}

const text = (blocks: Block[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");

test("an agent on a remote machine drives its workspace's tabs in this Mac's browser, and only those", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  let closed = false;
  try {
    // A tailnet's round trip in each direction.
    remote = await addRemote(crew, "devbox", { latencyMs: 60 });
    const machine = remote;
    const web = await crew.makeRepo("web");
    const workspace = await remoteRequest<Workspace>(machine, "workspace_create", { name: "web", path: web });
    await crew.reload();
    const tool = (name: string, args: object = {}) => remoteTool(machine, workspace.id, name, args);

    // Main links to the machine once it is in the address book; until then the machine says no Mac is there.
    const opened = await waitFor(() => tool("open_tab", { url: `http://localhost:${port}/order` }).catch(() => null), {
      timeout: 40_000,
      interval: 500,
      message: "open_tab reaches this Mac from the machine",
    });
    const tab = /Opened (browser:\S+)/.exec(text(opened))?.[1];
    assert.ok(tab, text(opened));
    assert.match(text(opened), /over the network/);

    // The tab is saved in this Mac's strip of the remote workspace, and the machine lists it from what main reports.
    await waitFor(async () => (await savedStrip(crew, workspace.id))?.ids.includes(tab) ?? false, {
      message: "the new tab is in this Mac's strip of the remote workspace",
    });
    const listed = await waitFor(async () => {
      const list = text(await tool("list_tabs"));
      return list.includes(tab) && list.includes("Order") ? list : null;
    }, { message: "the machine lists the tab with its title, as main reported it" });
    assert.match(listed, /^Crew's browser on .+, over the network/);

    // Read, filled, clicked and evaluated from the machine.
    const snapshot = text(await tool("browser_snapshot"));
    const uid = (pattern: RegExp) => {
      const found = pattern.exec(snapshot)?.[1];
      assert.ok(found, `${pattern} in:\n${snapshot}`);
      return found;
    };
    await tool("browser_act", { action: "fill", uid: uid(/uid=(\S+) textbox "Email"/), value: "ada@example.com" });
    await tool("browser_act", { action: "click", uid: uid(/uid=(\S+) button "Send"/) });
    assert.equal(text(await tool("browser_evaluate", { expression: "document.title" })), '"Sent ada@example.com"');

    // A screenshot crosses as JPEG, the smaller of the two.
    const [shot] = await tool("browser_screenshot");
    assert.equal(shot?.type, "image");
    assert.ok(shot.type === "image" && shot.mimeType === "image/jpeg", shot.type === "image" ? shot.mimeType : "");
    assert.ok(Buffer.from(shot.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "JPEG bytes");

    // The machine holds the lease.
    const leases = await remoteRequest<BrowserLeases>(machine, "browser_leases_list");
    assert.deepEqual(leases.leases.map((lease) => lease.tab), [tab]);

    // This Mac's own tabs are not the machine's to drive, whatever id it names.
    const [mine] = crew.workspaces;
    assert.ok(mine);
    const local = text(await crew.request<Block[]>("browser_tool", { workspaceId: mine.id, tool: "open_tab", args: { url: `http://127.0.0.1:${port}/mine` } }));
    const localTab = /Opened (browser:\S+)/.exec(local)?.[1];
    assert.ok(localTab, local);
    await assert.rejects(tool("browser_snapshot", { tab: localTab }), /There is no tab/);
    assert.ok(!text(await tool("list_tabs")).includes(localTab), "the machine does not see this Mac's tab");

    // A workspace made on the machine after main linked to it takes a tab at once:
    // main looks its workspaces up again rather than turning the call away.
    const api = await remoteRequest<Workspace>(machine, "workspace_create", { name: "api", path: await crew.makeRepo("api") });
    // The window shows it (the user made it there); main's own list of the machine's workspaces is still the old one.
    await crew.reload();
    const fresh = text(await remoteTool(machine, api.id, "open_tab", { url: `http://localhost:${port}/api` }));
    const freshTab = /Opened (browser:\S+)/.exec(fresh)?.[1];
    assert.ok(freshTab, fresh);
    await waitFor(async () => (await savedStrip(crew, api.id))?.ids.includes(freshTab) ?? false, {
      message: "the new workspace's tab is in its strip",
    });

    // The machine restarts: main dials it again, reports the tabs, and the tab drives as before.
    await machine.stop();
    await machine.start();
    // The page may be loading again as the machine comes back, so it is read until it shows.
    await waitFor(async () => /heading "Order"/.test(text(await tool("browser_snapshot", { tab }))), {
      timeout: 40_000,
      interval: 500,
      message: "the tab drives again once the machine is back",
    });

    // Crew closes: the machine says no Mac is connected, rather than to open a Crew it does not have.
    await crew.close();
    closed = true;
    const empty = await waitFor(async () => {
      const list = text(await tool("list_tabs"));
      return list.includes("No Mac with Crew open") ? list : null;
    }, { message: "the machine knows the Mac went away" });
    assert.match(empty, /No browser tabs here/);
    await assert.rejects(tool("browser_snapshot", { tab }), /was on .+, which is no longer connected/);
    await assert.rejects(tool("open_tab", { url: `http://localhost:${port}/` }), /No Mac with Crew open is connected to this machine/);
  } finally {
    await remote?.stop();
    if (!closed) await crew.close();
    server.closeAllConnections();
    server.close();
  }
});

test("two Macs on one machine: a tab opens where the user was last, each drives on its own Mac, and a sleeping one fails fast", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${request.url}</title><h1>${request.url}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const ada = await launchCrew();
  const studio = await launchCrew();
  let remote: RemoteDaemon | null = null;
  let stopped: number | null = null;
  try {
    remote = await addRemote(ada, "devbox");
    const machine = remote;
    await studio.window.evaluate((input) => window.crewHost!.remotes!.add(input), {
      id: "",
      name: "devbox",
      host: "127.0.0.1",
      port: machine.port,
      user: "agent",
      token: machine.token,
    });
    const web = await ada.makeRepo("web");
    const workspace = await remoteRequest<Workspace>(machine, "workspace_create", { name: "web", path: web });
    await ada.reload();
    await studio.reload();
    const tool = (name: string, args: object = {}) => remoteTool(machine, workspace.id, name, args);
    const focus = (crew: typeof ada) =>
      crew.app.evaluate(({ app, BrowserWindow }) => void app.emit("browser-window-focus", {}, BrowserWindow.getAllWindows()[0]));
    const openOn = async (crew: typeof ada, path: string) => {
      await focus(crew);
      const out = await waitFor(() => tool("open_tab", { url: `http://localhost:${port}${path}` }).catch(() => null), {
        timeout: 40_000,
        interval: 500,
        message: `open_tab ${path} reaches a Mac`,
      });
      const tab = /Opened (browser:\S+)/.exec(text(out))?.[1];
      assert.ok(tab, text(out));
      return tab;
    };
    const stripHas = (crew: typeof ada, tab: string) =>
      waitFor(async () => (await savedStrip(crew, workspace.id))?.ids.includes(tab) ?? false, { message: `${tab} is in that Mac's strip` });

    // Both Macs are hosts at once: each new tab opens on the Mac the user was at last.
    const onStudio = await openOn(studio, "/studio");
    await stripHas(studio, onStudio);
    const onAda = await openOn(ada, "/ada");
    await stripHas(ada, onAda);
    assert.ok(!(await savedStrip(studio, workspace.id))?.ids.includes(onAda), "each tab is on one Mac only");

    // The machine lists both and drives each on its own Mac.
    const list = await waitFor(async () => {
      const listed = text(await tool("list_tabs"));
      return listed.includes(onAda) && listed.includes(onStudio) ? listed : null;
    }, { message: "both Macs' tabs are listed" });
    assert.match(list, /^Crew's browser on the user's Macs/);
    assert.match(text(await tool("browser_snapshot", { tab: onAda })), /heading "\/ada"/);
    assert.match(text(await tool("browser_snapshot", { tab: onStudio })), /heading "\/studio"/);

    // Ada's Mac goes to sleep without closing its socket: its tab fails within seconds, not the whole budget,
    // and the other Mac's tab keeps working meanwhile.
    stopped = ada.app.process().pid ?? null;
    assert.ok(stopped);
    process.kill(stopped, "SIGSTOP");
    const started = Date.now();
    await assert.rejects(tool("browser_snapshot", { tab: onAda }), /did not answer \(asleep or offline\?\)/);
    const took = Date.now() - started;
    assert.ok(took < 15_000, `failed in ${took} ms`);
    assert.match(text(await tool("browser_snapshot", { tab: onStudio })), /heading "\/studio"/);
    process.kill(stopped, "SIGCONT");
    stopped = null;
    await waitFor(() => tool("browser_snapshot", { tab: onAda }).catch(() => null), { message: "Ada's Mac answers once awake", timeout: 20_000 });

    // Studio closes: its tab says where it went; Ada's still drives.
    await studio.close();
    await waitFor(async () => {
      try {
        await tool("browser_snapshot", { tab: onStudio });
        return false;
      } catch (error) {
        return /which is no longer connected/.test(String(error));
      }
    }, { message: "Studio's tab says its Mac went away" });
    assert.match(text(await tool("browser_snapshot", { tab: onAda })), /heading "\/ada"/);
    const after = text(await tool("list_tabs"));
    assert.ok(after.includes(onAda) && !after.includes(onStudio), after);
  } finally {
    if (stopped) process.kill(stopped, "SIGCONT");
    await remote?.stop();
    await ada.close();
    await studio.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
});
