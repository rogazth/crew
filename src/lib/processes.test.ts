import { describe, expect, it } from "vitest";
import { SEPARATOR, type MenuAction, type MenuEntry } from "./menu";
import {
  awaitsUser,
  formatEnv,
  isOrphan,
  liveRuns,
  parseEnv,
  processActions,
  removeProcess,
  replayEvents,
  rerunEnv,
  runActions,
  runIn,
  servedUrl,
  specChanges,
  specOf,
  startableIn,
  stateLabel,
  stateTone,
  upsertProcess,
  urlLabel,
  type Process,
  type ProcessRun,
} from "./processes";

function run(patch: Partial<ProcessRun> = {}): ProcessRun {
  return {
    worktree: null,
    state: "running",
    pid: 1,
    streamId: 1,
    startedAt: 0,
    exitCode: null,
    restarts: 0,
    ptyId: "process:p1:main",
    logCursor: 0,
    runCursor: 0,
    startedBy: null,
    env: {},
    url: null,
    ...patch,
  };
}

function process(patch: Partial<Process> = {}): Process {
  return {
    id: "p1",
    workspaceId: "w",
    name: "web",
    command: "npm run dev",
    cwd: "",
    env: {},
    autoRestart: false,
    createdBy: null,
    approved: true,
    proposed: null,
    requestedBy: null,
    runs: [],
    revision: 0,
    ...patch,
  };
}

const ids = (entries: MenuEntry[]) => entries.map((entry) => (entry === SEPARATOR ? "|" : (entry as MenuAction).id));

describe("processes", () => {
  it("keeps a known row in place and appends a new one", () => {
    const a = process({ id: "a" });
    const b = process({ id: "b" });
    const list = upsertProcess(upsertProcess([], a), b);
    const moved = upsertProcess(list, { ...a, runs: [run()] });
    expect(moved.map((p) => [p.id, p.runs.length])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
    expect(removeProcess(moved, "a").map((p) => p.id)).toEqual(["b"]);
    expect(removeProcess(moved, "zzz")).toBe(moved);
  });

  it("lays the events heard during a load over its answer", () => {
    // The list was read before "a" started and "b" was deleted.
    const answer = [process({ id: "a" }), process({ id: "b" })];
    const heard = [
      { kind: "changed" as const, process: process({ id: "a", runs: [run()] }) },
      { kind: "removed" as const, id: "b" },
      { kind: "changed" as const, process: process({ id: "c" }) },
    ];
    expect(replayEvents(answer, heard).map((p) => [p.id, p.runs.length])).toEqual([
      ["a", 1],
      ["c", 0],
    ]);
    expect(replayEvents(answer, [])).toBe(answer);
  });

  it("says why a run is down, and tells a restart from a first start", () => {
    expect(stateLabel(run({ state: "exited", exitCode: 1 }))).toBe("Exited with code 1");
    expect(stateLabel(run({ state: "exited", exitCode: null }))).toBe("Stopped by a signal");
    expect(stateLabel(run({ state: "starting", restarts: 2 }))).toBe("Restarting…");
    expect(stateLabel(run({ state: "starting" }))).toBe("Starting…");
    expect(stateLabel(undefined)).toBe("Stopped");
    expect(stateTone(run({ state: "exited", exitCode: 0 }))).toBe("quiet");
    expect(stateTone(run({ state: "exited", exitCode: 2 }))).toBe("danger");
    expect(stateTone(run())).toBe("success");
    expect(stateTone(undefined)).toBe("quiet");
  });

  it("finds a run by its worktree and counts the live ones", () => {
    const tree = run({ worktree: "/w-feat", state: "exited", exitCode: 0 });
    const web = process({ runs: [run(), tree] });
    const api = process({ id: "p2", runs: [run({ worktree: "/w-feat" })] });
    expect(runIn(web, "/w-feat")).toBe(tree);
    expect(runIn(web, "/elsewhere")).toBeUndefined();
    expect(liveRuns([web, api]).map(({ process, run }) => [process.id, run.worktree])).toEqual([
      ["p1", null],
      ["p2", "/w-feat"],
    ]);
  });

  it("calls a live run orphaned once the session that started it is gone", () => {
    const alive = new Set(["s1"]);
    expect(isOrphan(run({ startedBy: "s1" }), alive)).toBe(false);
    expect(isOrphan(run({ startedBy: "s2" }), alive)).toBe(true);
    expect(isOrphan(run({ startedBy: null }), alive)).toBe(false);
    expect(isOrphan(run({ startedBy: "s2", state: "exited" }), alive)).toBe(false);
  });

  it("offers what fits, and the pending decision first", () => {
    expect(ids(processActions(process()))).toEqual(["edit", "copy-command", "|", "delete"]);
    const pending = process({ approved: false, createdBy: "s1" });
    expect(awaitsUser(pending)).toBe(true);
    expect(ids(processActions(pending))).toEqual(["approve", "reject", "|", "edit", "copy-command", "|", "delete"]);

    expect(ids(runActions(process(), undefined))).toEqual(["start", "|", "logs"]);
    expect(ids(runActions(process(), run()))).toEqual(["stop", "restart", "|", "logs"]);
    expect(ids(runActions(process(), run({ state: "paused" })))).toEqual(["stop", "restart", "resume", "|", "logs"]);
    // Not approved means it cannot start: no Start to offer.
    expect(ids(runActions(pending, undefined))).toEqual(["logs"]);
  });

  it("reads and writes an environment as NAME=value lines", () => {
    const parsed = parseEnv('# local\nPORT=5173\nexport NODE_ENV="development"\n\nEMPTY=\nURL=a=b');
    expect(parsed).toEqual({
      env: { PORT: "5173", NODE_ENV: "development", EMPTY: "", URL: "a=b" },
      error: null,
    });
    expect(parseEnv("PORT 5173").error).toBe("Line 1: write it as NAME=value");
    expect(parseEnv("1BAD=x").error).toMatch(/Line 1/);
    expect(formatEnv({ A: "1", B: "two" })).toBe("A=1\nB=two");
  });

  it("lists what a proposal would change and nothing else", () => {
    const current = process({ env: { PORT: "3000" } });
    const proposed = { ...specOf(current), command: "npm run dev -- --host", env: { PORT: "4000" }, autoRestart: true };
    expect(specChanges(specOf(current), proposed)).toEqual([
      { field: "Command", before: "npm run dev", after: "npm run dev -- --host" },
      { field: "Environment", before: "PORT=3000", after: "PORT=4000" },
      { field: "Restart on crash", before: "Off", after: "On" },
    ]);
  });
});

describe("start and stop all", () => {
  it("starts every approved command not already up in the worktree", () => {
    const up = process({ id: "up", runs: [run({ worktree: "/t" })] });
    const elsewhere = process({ id: "elsewhere", runs: [run({ worktree: null })] });
    const crashed = process({ id: "crashed", runs: [run({ worktree: "/t", state: "crashed" })] });
    const unapproved = process({ id: "new", approved: false });
    const ids = startableIn([up, elsewhere, crashed, unapproved], "/t").map((p) => p.id);
    expect(ids).toEqual(["elsewhere", "crashed"]);
  });

  it("starts a run again with the env it set over the command's, and none otherwise", () => {
    const web = process({ env: { PORT: "3000" } });
    expect(rerunEnv(web, undefined)).toBeUndefined();
    expect(rerunEnv(web, run({ env: { PORT: "3000" } }))).toBeUndefined();
    expect(rerunEnv(web, run({ env: { PORT: "4011" } }))).toEqual({ PORT: "4011" });
  });
});

describe("served address", () => {
  it("offers what a run printed only while it is up", () => {
    const url = "http://localhost:5173/";
    expect(servedUrl(run({ url }))).toBe(url);
    expect(servedUrl(run({ url, state: "exited" }))).toBeNull();
    expect(servedUrl(undefined)).toBeNull();
  });

  it("reads as host and port, with a path only when there is one", () => {
    expect(urlLabel("http://localhost:5173/")).toBe("localhost:5173");
    expect(urlLabel("https://app.localhost:8443/admin")).toBe("app.localhost:8443/admin");
  });
});
