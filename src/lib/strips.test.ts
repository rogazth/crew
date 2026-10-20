import { describe, expect, it } from "vitest";
import { tabPlace } from "./strips";
import { fileTabId, newTerminalTab, sessionTabId, stubTabId } from "./tabs";
import type { Session, Tab, Workspace, Worktree } from "./types";

const workspace: Workspace = { id: "ws", name: "crew", path: "/repo", createdAt: 0 };
const tree = (path: string, main = false): Worktree => ({ path, branch: path, main, add: 0, del: 0, dirty: 0, locked: null });
const trees = [tree("/repo", true), tree("/wt/a"), tree("/wt/b")];
const session = (id: string, worktree: string | null) => ({ id, worktree }) as Session;
const sessions = [session("m1", null), session("a1", "/wt/a"), session("b1", "/wt/b"), session("gone", "/wt/gone")];

const run = (id: string): Tab => ({ id: sessionTabId(id), kind: "session", sessionId: id });
const file = (path: string): Tab => ({ id: fileTabId(path), kind: "file", path, relative: path.split("/").pop()! });
const page = (id: string): Tab => ({ id: `browser:${id}`, kind: "browser", url: "", title: id });

describe("tabPlace", () => {
  it("picks the deepest folder that holds a file", () => {
    const nested = [tree("/repo", true), tree("/repo/.worktrees/c")];
    expect(tabPlace(file("/repo/.worktrees/c/x.ts"), workspace, nested, [])).toBe("/repo/.worktrees/c");
    expect(tabPlace(file("/repo/.worktrees/cc/x.ts"), workspace, nested, [])).toBe("/repo");
  });

  it("gives pages, stubs and sessions it cannot find no worktree", () => {
    expect(tabPlace(page("x"), workspace, trees, sessions)).toBeNull();
    const stub: Tab = { id: stubTabId("terminal"), kind: "stub", stub: "terminal", title: "" };
    expect(tabPlace(stub, workspace, trees, sessions)).toBeNull();
    expect(tabPlace(run("nobody"), workspace, trees, sessions)).toBeNull();
  });

  it("keeps a terminal in the worktree it was opened in", () => {
    expect(tabPlace(newTerminalTab("/wt/a"), workspace, trees, sessions)).toBe("/wt/a");
    expect(tabPlace(newTerminalTab(null), workspace, trees, sessions)).toBe("/repo");
    expect(newTerminalTab(null).id).not.toBe(newTerminalTab(null).id);
  });
});
