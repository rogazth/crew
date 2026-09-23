import { describe, expect, it } from "vitest";
import { agentsOf, surfaceRoute } from "./surface";
import type { Session, Tab } from "./types";

function session(id: string, kind: Session["kind"] = "agent"): Session {
  return { id, kind } as Session;
}

const SESSIONS = [session("a1"), session("t1", "terminal")];

describe("surfaceRoute", () => {
  it("asks for a folder before anything else when there is no workspace", () => {
    const tab: Tab = { id: "file:/a", kind: "file", path: "/a", relative: "a" };
    expect(surfaceRoute(tab, SESSIONS, false)).toEqual({ kind: "no-workspace" });
  });

  it("shows the empty pane when no tab is open", () => {
    expect(surfaceRoute(null, SESSIONS, true)).toEqual({ kind: "no-tab" });
  });

  it("opens a file tab in the editor with its paths", () => {
    const tab: Tab = { id: "file:/w/src/a.ts", kind: "file", path: "/w/src/a.ts", relative: "src/a.ts" };
    expect(surfaceRoute(tab, SESSIONS, true)).toEqual({ kind: "file", path: "/w/src/a.ts", relative: "src/a.ts" });
  });

  it("shows a stub that has no runtime yet", () => {
    const tab: Tab = { id: "stub:browser", kind: "stub", stub: "browser", title: "Browser" };
    expect(surfaceRoute(tab, SESSIONS, true)).toEqual({ kind: "stub", stub: "browser", title: "Browser" });
  });

  it("leaves a terminal stub to the terminal overlay", () => {
    const tab: Tab = { id: "stub:terminal", kind: "stub", stub: "terminal", title: "Terminal" };
    expect(surfaceRoute(tab, SESSIONS, true)).toEqual({ kind: "overlay" });
  });

  it("leaves a known session to its overlay", () => {
    expect(surfaceRoute({ id: "session:t1", kind: "session", sessionId: "t1" }, SESSIONS, true)).toEqual({
      kind: "overlay",
    });
  });

  it("says so when a session tab points at a session that is gone", () => {
    expect(surfaceRoute({ id: "session:x", kind: "session", sessionId: "x" }, SESSIONS, true)).toEqual({
      kind: "missing-session",
    });
  });
});

describe("agentsOf", () => {
  it("keeps agents in order and drops terminals", () => {
    expect(agentsOf([session("a1"), session("t1", "terminal"), session("a2")]).map((s) => s.id)).toEqual([
      "a1",
      "a2",
    ]);
  });
});
