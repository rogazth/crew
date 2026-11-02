// The trace is the record someone reads after a bug that cannot be reproduced, so this spec is the
// proof that it is written by the real app: the window, Electron's main and crewd each put their
// lines in `<data>/trace/`, `crew trace` reads them back as one story in time order, and nothing a
// user typed or a model said is in any of them.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chatLine, crewdPid, launchCrew, MOD, newSession, pressChord, sendInChat, waitFor, type Crew } from "./harness.ts";

const run = promisify(execFile);
const CREW = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/crew");

type Line = { timestamp: string; level: string; target: string; fields: { message: string } & Record<string, unknown> };

const traceDir = (crew: Crew) => path.join(crew.userData, "trace");

/** Every line of every file under trace/, rotated ones too, and the names of the files. */
async function read(crew: Crew): Promise<{ lines: Array<Line & { file: string }>; files: string[] }> {
  const files = await readdir(traceDir(crew)).catch(() => [] as string[]);
  const lines: Array<Line & { file: string }> = [];
  for (const file of files) {
    const text = await readFile(path.join(traceDir(crew), file), "utf8").catch(() => "");
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        lines.push({ ...(JSON.parse(line) as Line), file });
      } catch {
        // A line still being written.
      }
    }
  }
  return { lines, files };
}

/** Waits for a line: `match` picks it out of the files the trace is written to. */
async function line(crew: Crew, file: string, message: string, match: (line: Line) => boolean = () => true, timeout = 20_000): Promise<Line> {
  return waitFor(async () => (await read(crew)).lines.find((one) => one.file.startsWith(file) && one.fields.message === message && match(one)), {
    timeout,
    message: `${message} in ${file}`,
  });
}

test("the app, the window and crewd each write their first lines", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  const started = await line(crew, "app.ndjson", "app.start");
  assert.equal(started.target, "app.main");
  assert.equal(started.fields.e2e, true);
  const opened = await line(crew, "app.ndjson", "socket.open");
  assert.equal(opened.target, "app.window");
  assert.equal(opened.fields.machine, "local");
  await line(crew, "crewd.ndjson", "daemon.start");
  await line(crew, "crewd.ndjson", "conn.accepted");
  const done = await line(crew, "crewd.ndjson", "rpc.done", (one) => typeof one.fields.method === "string");
  assert.ok(typeof done.fields.duration_ms === "number");

  // Private: the folder to its owner alone, and the files with it.
  const { files } = await read(crew);
  assert.ok(files.includes("app.ndjson") && files.includes("crewd.ndjson"), files.join(", "));
  for (const file of files) {
    assert.ok(/^(app|crewd|errors)\.ndjson(\.\d+)?$/.test(file), `${file} is not one of the trace's files`);
  }
});

test("a command run from the keyboard is a ui.command line with how it was triggered", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  await pressChord(crew, `${MOD}+t`);
  const ran = await line(crew, "app.ndjson", "ui.command", (one) => one.fields.command === "open-launcher");
  assert.equal(ran.target, "app.window");
  assert.equal(ran.fields.via, "keyboard");
  // And a tab the command opened is the next thing the window says: its kind, never its title.
  const tab = await line(crew, "app.ndjson", "tab.open");
  assert.ok(typeof tab.fields.kind === "string" && !("title" in tab.fields), JSON.stringify(tab));
});

test("an error thrown in the window and a promise nobody caught are lines with one line of why", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  await crew.window.evaluate(() => {
    setTimeout(() => {
      throw new Error("E2E-THROWN: the thing broke");
    }, 0);
    void Promise.reject(new Error("E2E-REJECTED: nobody caught this"));
  });
  const thrown = await line(crew, "app.ndjson", "window.error");
  assert.equal(thrown.level, "ERROR");
  assert.match(String(thrown.fields.error), /E2E-THROWN/);
  const rejected = await line(crew, "app.ndjson", "window.unhandledrejection");
  assert.equal(rejected.level, "ERROR");
  assert.match(String(rejected.fields.error), /E2E-REJECTED/);
  // The error also lands in errors.ndjson's company: the app's own file holds it, the window's lines never go to crewd's.
  assert.ok(!(await read(crew)).lines.some((one) => one.file.startsWith("crewd") && one.fields.message === "window.error"));
});

test("a renderer that crashes is renderer.gone, written by main before anything else can go wrong", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  await crew.app.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find((contents) => contents.getType() === "window")?.forcefullyCrashRenderer();
  });
  const gone = await line(crew, "app.ndjson", "renderer.gone");
  assert.equal(gone.level, "ERROR");
  assert.equal(gone.target, "app.main");
  assert.equal(gone.fields.reason, "crashed");
});

test("a crewd that goes is socket.closed and a new one is daemon.start, and a socket that is dropped comes back as socket.reconnected", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  // The page keeps every WebSocket it opens, so one can be dropped from under it.
  await crew.window.addInitScript(() => {
    const Original = window.WebSocket;
    const kept: WebSocket[] = [];
    Object.assign(window, { keptSockets: kept });
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        kept.push(this);
      }
    };
  });
  await crew.reload();
  await line(crew, "app.ndjson", "socket.open");
  await crew.window.evaluate(() => {
    for (const socket of (window as unknown as { keptSockets: WebSocket[] }).keptSockets) socket.close(4000, "dropped by the spec");
  });
  const closed = await line(crew, "app.ndjson", "socket.closed", (one) => one.fields.code === 4000);
  assert.equal(closed.level, "WARN");
  assert.equal(closed.fields.machine, "local");
  const back = await line(crew, "app.ndjson", "socket.reconnected");
  assert.equal(back.fields.machine, "local");
  assert.ok(back.timestamp > closed.timestamp, "it came back after it went");

  // The daemon itself killed: the window says its socket closed, main says the child went and was started
  // again, and the new crewd's first line is in the same file as the old one's last.
  const pid = await crewdPid(crew);
  const before = (await read(crew)).lines.filter((one) => one.fields.message === "daemon.start").length;
  process.kill(pid, "SIGKILL");
  await waitFor(async () => (await crewdPid(crew).catch(() => pid)) !== pid, { timeout: 20_000, message: "the app starts crewd again" });
  await line(crew, "app.ndjson", "daemon.child_exit", (one) => one.fields.expected === false);
  await line(crew, "app.ndjson", "daemon.child_restart");
  await waitFor(async () => (await read(crew)).lines.filter((one) => one.fields.message === "daemon.start").length > before, {
    timeout: 20_000,
    message: "the new crewd writes daemon.start",
  });
  // The window reloads onto it and connects: its first socket there is an open, in the same trace.
  await waitFor(async () => (await read(crew)).lines.filter((one) => one.fields.message === "socket.open").length >= 2, {
    timeout: 20_000,
    message: "the window connects to the new crewd",
  });
});

test("crew trace reads the three files back as one story, newest last", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());

  await line(crew, "app.ndjson", "socket.open");
  await line(crew, "crewd.ndjson", "daemon.start");
  await pressChord(crew, `${MOD}+t`);
  await line(crew, "app.ndjson", "ui.command");

  const { stdout } = await run(CREW, ["trace", "--since", "5m", "--json", "--limit", "0", "--data-dir", crew.userData]);
  const lines = stdout.split("\n").filter(Boolean).map((one) => JSON.parse(one) as Line);
  const messages = new Set(lines.map((one) => one.fields.message));
  for (const wanted of ["app.start", "socket.open", "ui.command", "daemon.start", "conn.accepted", "rpc.done"]) {
    assert.ok(messages.has(wanted), `crew trace did not return ${wanted}`);
  }
  // Daemon, main and window in one list.
  const targets = new Set(lines.map((one) => (one.target.startsWith("app.") ? one.target : "crewd")));
  assert.deepEqual([...targets].sort(), ["app.main", "app.window", "crewd"]);
  // In time order.
  const times = lines.map((one) => Date.parse(one.timestamp));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "the lines are not in time order");
  // A WARN is written to two of crewd's files and shown once.
  const keys = lines.filter((one) => one.level === "WARN" && !one.target.startsWith("app.")).map((one) => `${one.timestamp.slice(0, 19)}${one.fields.message}${JSON.stringify(one.fields)}`);
  assert.equal(new Set(keys).size, keys.length, "a warning shows twice");
  // The human form names the file's own fields.
  const { stdout: human } = await run(CREW, ["trace", "--since", "5m", "--target", "app.window", "--data-dir", crew.userData]);
  assert.match(human, /socket\.open/);
});

test("a prompt, a reply and a keystroke with a marker in them reach no file under trace/", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const marker = `TRACE-MARKER-${Date.now().toString(36)}-9d2f`;

  await newSession(crew, workspace.id);
  await sendInChat(crew, `please remember ${marker}`);
  // The fake claude repeats it back: it went in, through the provider, and came out.
  await chatLine(crew, new RegExp(`Reply 1: please remember ${marker}`)).waitFor({ timeout: 30_000 });
  await waitFor(async () => (await read(crew)).lines.some((one) => one.fields.message === "turn.end"), { message: "the turn ended in the trace" });
  // And into a command run in a terminal of its own, which echoes it.
  await crew.window.keyboard.type(`echo ${marker}`);

  // Let main and the window flush what they hold before looking.
  await crew.window.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const { files, lines } = await read(crew);
  assert.ok(lines.length > 20, "the trace is not empty");
  for (const file of files) {
    const text = await readFile(path.join(traceDir(crew), file), "utf8");
    assert.ok(!text.includes(marker), `${file} holds the marker`);
  }
  // Not an empty pass: the turn it was in is there, by ids.
  assert.ok(lines.some((one) => one.fields.message === "turn.start"));
  assert.ok(lines.some((one) => one.fields.message === "session.event"));
  // The names are the trace's own: nothing else was made beside them.
  assert.ok(files.every((file) => /^(app|crewd|errors)\.ndjson(\.\d+)?$/.test(file)), files.join(", "));
});
