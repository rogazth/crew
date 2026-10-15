import { describe, expect, it } from "vitest";
import type { BrowserCall } from "./agent-tools";
import { gateCall, remoteBackoff, workspaceOf, type Scope } from "./remote-hosts";

const page = (pageId: string, context: string) => ({ pageId, context, url: "http://localhost:5173/", title: "App" });

function scope(): Scope {
  return {
    workspaces: new Set(["w-remote"]),
    pages: new Map([["browser:mine", page("browser:mine", "w-remote@/srv/app/feat")]]),
    opened: new Set(),
  };
}

const call = (tab: string, tool: string, context?: string): BrowserCall => ({
  callId: 1,
  tab,
  tool,
  args: {},
  ...(context !== undefined && { page: { context, url: "http://evil/", title: "x" } }),
});

describe("what a remote machine may drive", () => {
  it("runs a call on a tab main told it of, with this Mac's page and not the machine's", () => {
    const gated = gateCall(call("browser:mine", "browser_snapshot", "w-local"), scope(), () => false);
    expect(gated).toMatchObject({ page: { context: "w-remote@/srv/app/feat", url: "http://localhost:5173/" } });
  });

  it("refuses a tab it was never told of, this Mac's own tabs above all", () => {
    expect(gateCall(call("browser:local", "browser_snapshot", "w-remote"), scope(), () => true)).toMatch(/There is no tab browser:local/);
  });

  it("opens a new tab only in one of its own workspaces, under an id nobody here uses", () => {
    const s = scope();
    // Into another workspace: the window would have made the tab there.
    expect(gateCall(call("browser:new", "open_tab", "w-local"), s, () => false)).toMatch(/There is no tab/);
    expect(gateCall(call("browser:new", "open_tab"), s, () => false)).toMatch(/There is no tab/);
    // Under the id of a tab this Mac shows: open_tab would hand over that page.
    expect(gateCall(call("browser:taken", "open_tab", "w-remote"), s, () => true)).toMatch(/There is no tab/);
    expect(gateCall(call("browser:new", "open_tab", "w-remote@/srv/app/feat"), s, () => false)).not.toBeTypeOf("string");
    // Before its strip is saved, the tab it opened is still its own.
    expect(gateCall(call("browser:new", "browser_snapshot", "w-remote"), s, () => true)).not.toBeTypeOf("string");
    expect(gateCall(call("browser:new", "browser_snapshot", "w-local"), s, () => true)).toMatch(/There is no tab/);
  });

  it("splits a worktree strip from its workspace", () => {
    expect(workspaceOf("w1@/srv/a@b")).toBe("w1");
    expect(workspaceOf("w1")).toBe("w1");
  });

  it("dials a machine that does not answer less and less often", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(remoteBackoff)).toEqual([1000, 1000, 2000, 4000, 8000, 15_000, 15_000]);
  });
});
