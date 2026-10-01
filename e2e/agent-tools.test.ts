// Every tool an agent is handed, end to end through the real app: the browser
// tools over crewd's relay to Electron main and a tab's guest, and the process
// tools over the supervised PTYs. Three callers, as the bridge tells them
// apart: the user (the window's RPC and the `crew` CLI with daemon.json), and
// a terminal session (its own token, with autonomy full and then ask).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BrowserLeases } from "../src/lib/protocol.ts";
import { launchCrew, newTerminal, typeInTerminal, waitFor, type Crew } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CREW = path.join(ROOT, "target/debug/crew");
const execFileAsync = promisify(execFile);

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const ORDER = `<!doctype html><title>Order</title>
<h1>Order</h1>
<label>Email <input id="email" value="old@example.com"></label>
<label>Size <select id="size"><option>S</option><option>L</option></select></label>
<button onclick="document.title = 'Sent ' + email.value + ' ' + size.value">Send</button>
<form onsubmit="event.preventDefault(); document.title = 'Searched ' + q.value">
  <input id="q" aria-label="Query">
</form>
<button id="hover" onmouseover="this.textContent = 'Hovered'">Hover me</button>
<button onclick="console.log('crew-console-marker'); console.error('crew-error-marker'); fetch('/api/ping')">Log</button>
<a href="/next">Next</a>
<script>setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'late arrival' })), 1500)</script>`;

const NEXT = `<!doctype html><title>Next</title><h1>Next page</h1>`;

async function pages(t: TestContext): Promise<string> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"pong":true}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/next" ? NEXT : ORDER);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const text = (blocks: Block[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");

function uidOf(snapshot: string, pattern: RegExp): string {
  const found = pattern.exec(snapshot)?.[1];
  assert.ok(found, `${pattern} in:\n${snapshot}`);
  return found;
}

/** `crew` as the user outside any session: daemon.json from the sandbox's data dir. */
function crewCli(crew: Crew, cwd: string) {
  const { CREW_SOCKET: _socket, CREW_TOKEN: _token, ...env } = process.env;
  return async (...args: string[]) => {
    const { stdout } = await execFileAsync(CREW, args, {
      cwd,
      env: { ...env, HOME: crew.home, CREW_DATA_DIR: crew.userData },
      timeout: 90_000,
    });
    return stdout;
  };
}

test("T1: every browser tool, as the user, on a tab behind the one on screen", async (t) => {
  const base = await pages(t);
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const tool = (name: string, args: object = {}) =>
    crew.request<Block[]>("browser_tool", { workspaceId: workspace.id, tool: name, args });

  const opened = await waitFor(() => tool("open_tab", { url: `${base}/order` }).catch(() => null), {
    timeout: 30_000,
    interval: 250,
    message: "open_tab reaches the browser host",
  });
  const tab = /Opened (browser:\S+)/.exec(text(opened))?.[1];
  assert.ok(tab, text(opened));

  const listed = text(await tool("list_tabs"));
  assert.ok(listed.includes(tab) && listed.includes("/order"), listed);

  await tool("browser_wait_for", { text: "late arrival", timeout_s: 10 });

  let snapshot = text(await tool("browser_snapshot"));
  assert.match(snapshot, /heading "Order" level=1/);
  await tool("browser_fill", { uid: uidOf(snapshot, /uid=(\S+) textbox "Email"/), value: "ada@example.com" });
  await tool("browser_fill", { uid: uidOf(snapshot, /uid=(\S+) combobox "Size"/), value: "L" });
  await tool("browser_click", { uid: uidOf(snapshot, /uid=(\S+) button "Send"/) });
  assert.equal(text(await tool("browser_evaluate", { expression: "document.title" })), '"Sent ada@example.com L"');

  await tool("browser_hover", { uid: uidOf(snapshot, /uid=(\S+) button "Hover me"/) });
  assert.equal(text(await tool("browser_evaluate", { expression: "document.getElementById('hover').textContent" })), '"Hovered"');

  await tool("browser_click", { uid: uidOf(snapshot, /uid=(\S+) textbox "Query"/) });
  await tool("browser_type", { text: "crew rocks" });
  await tool("browser_press", { key: "Enter" });
  assert.equal(text(await tool("browser_evaluate", { expression: "document.title" })), '"Searched crew rocks"');

  await tool("browser_click", { uid: uidOf(snapshot, /uid=(\S+) button "Log"/) });
  await waitFor(async () => text(await tool("browser_console")).includes("crew-error-marker"), {
    message: "the console has the page's messages",
  });
  const consoleText = text(await tool("browser_console"));
  assert.ok(consoleText.includes("crew-console-marker"), consoleText);
  await waitFor(async () => /\/api\/ping/.test(text(await tool("browser_network"))), {
    message: "the network log has the fetch",
  });
  assert.match(text(await tool("browser_network")), /GET.*200.*\/api\/ping|\/api\/ping.*200/);

  const path = async () => text(await tool("browser_evaluate", { expression: "location.pathname" }));
  await tool("browser_navigate", { url: `${base}/next` });
  snapshot = text(await tool("browser_snapshot"));
  assert.match(snapshot, /heading "Next page" level=1/);
  await tool("browser_navigate", { action: "back" });
  await waitFor(async () => (await path()) === '"/order"', { message: "back goes to /order" });
  await tool("browser_navigate", { action: "forward" });
  await waitFor(async () => (await path()) === '"/next"', { message: "forward goes to /next" });
  await tool("browser_navigate", { action: "reload" });
  assert.equal(await path(), '"/next"');

  for (const full_page of [false, true]) {
    const [shot] = await tool("browser_screenshot", { full_page });
    assert.equal(shot?.type, "image");
    assert.ok(shot.type === "image" && Buffer.from(shot.data, "base64").subarray(1, 4).toString() === "PNG");
  }

  const leases = () => crew.request<BrowserLeases>("browser_leases_list");
  await tool("release_tab", { tab });
  await waitFor(async () => (await leases()).leases.length === 0, { message: "release_tab frees it" });
  await tool("claim_tab", { tab });
  assert.deepEqual((await leases()).leases.map((lease) => [lease.tab, lease.holder]), [[tab, "you"]]);

  // Refusals an agent reads and acts on.
  await assert.rejects(tool("open_tab", { url: "file:///etc/passwd" }), /Only http\(s\) pages/);
  await assert.rejects(tool("browser_click", { tab, uid: "nope" }), /snapshot/i);
});

test("T2: the crew CLI, as the user, runs a process's whole life and lists the tabs", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const crewCmd = crewCli(crew, workspace.path);

  const status = await crewCmd("status");
  assert.match(status, /caller\s+the user/);
  assert.match(status, /daemon\s+running/);

  // Reads a line and echoes it, so send_input has something to answer.
  const script = `echo booting; sleep 0.5; echo ready on 4000; while read line; do echo "got $line"; done`;
  await crewCmd("processes", "add", "echoer", "--", "sh", "-c", `'${script}'`);
  const listed = JSON.parse(await crewCmd("processes", "list", "--json")) as unknown;
  assert.ok(JSON.stringify(listed).includes("echoer"), JSON.stringify(listed));

  await crewCmd("processes", "start", "echoer");
  const waited = await crewCmd("processes", "wait", "echoer", "ready on", "--timeout-s", "20");
  assert.match(waited, /matched|ready on 4000/);

  await crewCmd("processes", "input", "echoer", "hello\r");
  await waitFor(async () => (await crewCmd("processes", "logs", "echoer")).includes("got hello"), { message: "send_input reaches it" });

  const grep = await crewCmd("processes", "logs", "echoer", "--grep", "ready|got");
  assert.match(grep, /ready on 4000/);
  assert.match(grep, /got hello/);
  const read = JSON.parse(await crewCmd("processes", "logs", "echoer", "-n", "10", "--json")) as unknown;
  assert.ok(JSON.stringify(read).includes("booting"), JSON.stringify(read));

  await crewCmd("processes", "pause", "echoer");
  assert.match(await crewCmd("processes", "list"), /paused/);
  await crewCmd("processes", "resume", "echoer");
  assert.match(await crewCmd("processes", "list"), /running/);
  await crewCmd("processes", "restart", "echoer");
  await crewCmd("processes", "wait", "echoer", "ready on", "--timeout-s", "20");
  await crewCmd("processes", "edit", "echoer", "--auto-restart", "true");
  await crewCmd("processes", "stop", "echoer");
  assert.match(await crewCmd("processes", "list"), /stopped|exited/);
  await crewCmd("processes", "rm", "echoer");
  assert.ok(!(await crewCmd("processes", "list")).includes("echoer"));

  // The browser from a shell: the tabs the workspace has.
  assert.match(await crewCmd("tabs", "list"), /./);
});

test("T3: a terminal session drives the browser and processes with its own token, gated by its autonomy", async (t) => {
  const base = await pages(t);
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const shell = await newTerminal(crew, workspace.id);
  const setAutonomy = (autonomy: "full" | "ask") =>
    crew.request("session_update", {
      id: shell.id,
      name: shell.name,
      provider: shell.provider,
      model: shell.model ?? "",
      description: shell.description ?? "",
      notifications: shell.notifications,
      autonomy,
    });

  const launch = (await crew.claudeLaunches()).find((row) => row.argv.includes(shell.id));
  assert.ok(launch, "the terminal's CLI started");

  // One `!` runs a script in the session's shell, with the env the daemon gave it.
  let run = 0;
  const inSession = async (lines: string[]) => {
    run += 1;
    const script = path.join(launch.cwd, `.crew-tools-${run}.sh`);
    const out = path.join(launch.cwd, `.crew-tools-${run}.out`);
    await writeFile(
      script,
      ["set +e", `exec > '${out}.part' 2>&1`, ...lines, `mv '${out}.part' '${out}'`].join("\n"),
    );
    await typeInTerminal(crew, `!sh '${script}'`);
    return waitFor(() => readFile(out, "utf8").catch(() => null), { timeout: 60_000, message: `script ${run} ends` });
  };

  await setAutonomy("full");
  const full = await inSession([
    `echo "== whoami"; '${CREW}' status`,
    `echo "== open"; '${CREW}' tabs open '${base}/order'`,
    `echo "== tabs"; '${CREW}' tabs list`,
    `echo "== snapshot"; '${CREW}' tabs snapshot`,
    `echo "== evaluate"; '${CREW}' tabs eval 1+1`,
    `echo "== proc"; '${CREW}' processes add ticker -- sh -c "'while true; do echo tick; sleep 1; done'"`,
    `echo "== start"; '${CREW}' processes start ticker`,
    `echo "== wait"; '${CREW}' processes wait ticker tick --timeout-s 20`,
    `echo "== input"; '${CREW}' processes input ticker x && echo input-ok`,
    `echo "== stop"; '${CREW}' processes stop ticker`,
    `echo "== user"; '${CREW}' --data-dir /nowhere processes list >/dev/null 2>&1 && echo still-the-session`,
    `echo "== daemon"; '${CREW}' daemon status; echo "exit=$?"`,
  ]);
  assert.match(full, new RegExp(shell.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), full);
  const tab = /Opened (browser:\S+)/.exec(full)?.[1];
  assert.ok(tab, full);
  assert.match(full, /heading "Order" level=1/, full);
  assert.match(full, /== evaluate\n2/, full);
  assert.match(full, /input-ok/, full);
  assert.match(full, /still-the-session/, full);
  assert.match(full, /== daemon\n[\s\S]*exit=[12]/, full);
  const leases = await crew.request<BrowserLeases>("browser_leases_list");
  assert.deepEqual(
    leases.leases.map((lease) => [lease.tab, lease.sessionId ?? null]),
    [[tab, shell.id]],
    "the tab is the terminal's",
  );

  // Its tab is its own: the user's call waits for the lease, it is not taken.
  await assert.rejects(
    crew.request("browser_tool", { workspaceId: workspace.id, tool: "browser_snapshot", args: { tab } }),
    /in use by/,
  );

  await setAutonomy("ask");
  const ask = await inSession([
    `echo "== evaluate"; '${CREW}' tabs eval 1+1; echo "exit=$?"`,
    `echo "== snapshot"; '${CREW}' tabs snapshot >/dev/null && echo snapshot-ok`,
    `echo "== input"; '${CREW}' processes input ticker x; echo "exit=$?"`,
    `echo "== create"; '${CREW}' processes add proposed -- echo hi`,
    `echo "== start"; '${CREW}' processes start proposed; echo "exit=$?"`,
  ]);
  assert.match(ask, /== evaluate\n[\s\S]*autonomy[\s\S]*exit=1/, ask);
  assert.match(ask, /snapshot-ok/, ask);
  assert.match(ask, /== input\n[\s\S]*autonomy[\s\S]*exit=1/, ask);
  assert.match(ask, /pending/i, ask);
  assert.match(ask, /== start\n[\s\S]*exit=1/, ask);

  // The session's CLI exits: its token and its tabs go with it.
  process.kill(launch.pid, "SIGTERM");
  await waitFor(async () => (await crew.request<BrowserLeases>("browser_leases_list")).leases.length === 0, {
    timeout: 15_000,
    message: "the terminal's lease goes when its process exits",
  });
});

test("T4: crew mcp speaks MCP on stdio, lists only the gateway and finds the browser tools", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const { CREW_SOCKET: _socket, CREW_TOKEN: _token, ...env } = process.env;
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_tool", arguments: { query: "browser snapshot" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ];
  const child = execFile(CREW, ["mcp"], { cwd: workspace.path, env: { ...env, HOME: crew.home, CREW_DATA_DIR: crew.userData } });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stdin?.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  await waitFor(() => stdout.split("\n").filter(Boolean).length >= 3, { timeout: 15_000, message: "three answers" });
  child.stdin?.end();
  const [init, found, listed] = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { result?: unknown });
  assert.ok(JSON.stringify(init?.result).includes("instructions"), stdout);
  assert.ok(JSON.stringify(found?.result).includes("browser_snapshot"), stdout);
  // Nothing else is in the prompt: the rest is behind find_tool.
  const names = (listed?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  assert.deepEqual(names, ["find_tool", "call_tool"], stdout);
});
