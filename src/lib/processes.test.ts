import { describe, expect, it } from "vitest";
import { SEPARATOR, type MenuAction } from "./menu";
import {
  awaitsUser,
  formatEnv,
  parseEnv,
  processActions,
  removeProcess,
  replayEvents,
  specChanges,
  specOf,
  stateLabel,
  stateTone,
  upsertProcess,
  type Process,
} from "./processes";

function process(patch: Partial<Process> = {}): Process {
  return {
    id: "p1",
    workspaceId: "w",
    name: "web",
    command: "npm run dev",
    cwd: "",
    env: {},
    autoStart: false,
    autoRestart: false,
    createdBy: null,
    approved: true,
    proposed: null,
    requestedBy: null,
    state: "stopped",
    pid: null,
    streamId: null,
    startedAt: null,
    exitCode: null,
    restarts: 0,
    ptyId: "process:p1",
    logCursor: 0,
    runCursor: 0,
    revision: 0,
    ...patch,
  };
}

const ids = (p: Process) =>
  processActions(p).map((entry) => (entry === SEPARATOR ? "|" : (entry as MenuAction).id));

describe("processes", () => {
  it("keeps a known row in place and appends a new one", () => {
    const a = process({ id: "a" });
    const b = process({ id: "b" });
    const list = upsertProcess(upsertProcess([], a), b);
    const moved = upsertProcess(list, { ...a, state: "running" });
    expect(moved.map((p) => [p.id, p.state])).toEqual([
      ["a", "running"],
      ["b", "stopped"],
    ]);
    expect(removeProcess(moved, "a").map((p) => p.id)).toEqual(["b"]);
    expect(removeProcess(moved, "zzz")).toBe(moved);
  });

  it("lays the events heard during a load over its answer", () => {
    // The list was read before "a" started and "b" was deleted.
    const answer = [process({ id: "a" }), process({ id: "b" })];
    const heard = [
      { kind: "changed" as const, process: process({ id: "a", state: "running" }) },
      { kind: "removed" as const, id: "b" },
      { kind: "changed" as const, process: process({ id: "c" }) },
    ];
    expect(replayEvents(answer, heard).map((p) => [p.id, p.state])).toEqual([
      ["a", "running"],
      ["c", "stopped"],
    ]);
    expect(replayEvents(answer, [])).toBe(answer);
  });

  it("says why it is down, and tells a restart from a first start", () => {
    expect(stateLabel(process({ state: "exited", exitCode: 1 }))).toBe("Exited with code 1");
    expect(stateLabel(process({ state: "exited", exitCode: null }))).toBe("Stopped by a signal");
    expect(stateLabel(process({ state: "starting", restarts: 2 }))).toBe("Restarting…");
    expect(stateLabel(process({ state: "starting" }))).toBe("Starting…");
    expect(stateTone(process({ state: "exited", exitCode: 0 }))).toBe("quiet");
    expect(stateTone(process({ state: "exited", exitCode: 2 }))).toBe("danger");
    expect(stateTone(process({ state: "running" }))).toBe("success");
  });

  it("offers what fits the state, and the pending decision first", () => {
    expect(ids(process())).toEqual(["start", "|", "edit", "copy-command", "|", "delete"]);
    expect(ids(process({ state: "running" }))).toEqual([
      "stop",
      "restart",
      "pause",
      "|",
      "edit",
      "copy-command",
      "|",
      "delete",
    ]);
    expect(ids(process({ state: "paused" }))).toContain("resume");
    const pending = process({ approved: false, state: "pending-approval", createdBy: "s1" });
    expect(awaitsUser(pending)).toBe(true);
    // Not approved means it cannot start: no Start to offer.
    expect(ids(pending)).toEqual(["approve", "reject", "|", "edit", "copy-command", "|", "delete"]);
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
