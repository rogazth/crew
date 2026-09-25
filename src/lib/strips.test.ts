import { describe, expect, it } from "vitest";
import { joinStrips, splitStrip, tabPlace } from "./strips";
import { fileTabId, sessionTabId, stubTabId, type TabState } from "./tabs";
import type { Session, Tab, Workspace, Worktree } from "./types";

const workspace: Workspace = { id: "ws", name: "crew", path: "/repo", createdAt: 0 };
const tree = (path: string, main = false): Worktree => ({ path, branch: path, main, add: 0, del: 0, dirty: 0 });
const trees = [tree("/repo", true), tree("/wt/a"), tree("/wt/b")];
const paths = trees.map((t) => t.path);
const session = (id: string, worktree: string | null) => ({ id, worktree }) as Session;
const sessions = [session("m1", null), session("a1", "/wt/a"), session("b1", "/wt/b"), session("gone", "/wt/gone")];

const run = (id: string): Tab => ({ id: sessionTabId(id), kind: "session", sessionId: id });
const file = (path: string): Tab => ({ id: fileTabId(path), kind: "file", path, relative: path.split("/").pop()! });
const page = (id: string): Tab => ({ id: `browser:${id}`, kind: "browser", url: "", title: id });
const strip = (tabs: Tab[], activeId: string | null = null, closed: Tab[] = []): TabState => ({ tabs, activeId, closed });
const ids = (state: TabState | undefined) => state?.tabs.map((tab) => tab.id);
const placeOf = (tab: Tab) => tabPlace(tab, workspace, trees, sessions);

describe("joinStrips", () => {
  it("puts main's tabs first, then each worktree's, each in its own order", () => {
    const joined = joinStrips(
      [strip([run("m1"), file("/repo/a.md")]), strip([run("a1"), page("x")]), strip([run("b1")])],
      null,
    );
    expect(ids(joined)).toEqual([run("m1").id, fileTabId("/repo/a.md"), run("a1").id, "browser:x", run("b1").id]);
  });

  it("keeps a tab two strips hold once, at its first place", () => {
    const joined = joinStrips([strip([run("m1"), page("x")]), strip([page("x"), run("a1")])], null);
    expect(ids(joined)).toEqual([run("m1").id, "browser:x", run("a1").id]);
  });

  it("keeps the tab on screen on screen", () => {
    const joined = joinStrips([strip([run("m1")], run("m1").id), strip([run("a1")], run("a1").id)], run("a1").id);
    expect(joined.activeId).toBe(run("a1").id);
  });

  it("with nothing on screen, shows what the first strip showed", () => {
    const joined = joinStrips([strip([], null), strip([run("a1")], run("a1").id)], null);
    expect(joined.activeId).toBe(run("a1").id);
  });

  it("joins the reopen stacks, without the tabs that are open", () => {
    const joined = joinStrips([strip([run("m1")], null, [page("y")]), strip([], null, [run("m1"), page("z")])], null);
    expect(ids({ ...joined, tabs: joined.closed })).toEqual(["browser:y", "browser:z"]);
  });

  it("follows the tab on screen with each strip's recent order, one after another", () => {
    const main = { ...strip([run("m1"), run("m2")], run("m2").id), recent: [run("m2").id, run("m1").id] };
    // Saved before the recent order: its active tab stands for it.
    const a = strip([run("a1"), run("a2")], run("a1").id);
    const joined = joinStrips([main, a], run("a1").id);
    expect(joined.recent).toEqual([run("a1").id, run("m2").id, run("m1").id]);
  });
});

describe("splitStrip", () => {
  const joined = strip(
    [run("a1"), run("m1"), page("x"), file("/wt/b/src/x.ts"), run("b1"), file("/elsewhere/n.md"), run("gone")],
    run("b1").id,
    [page("old")],
  );
  const split = splitStrip(joined, paths, "/wt/a", placeOf);

  it("sends each session tab to where its session runs, and a gone worktree's to main", () => {
    expect(ids(split.get("/repo"))).toContain(run("m1").id);
    expect(ids(split.get("/repo"))).toContain(run("gone").id);
    expect(ids(split.get("/wt/a"))).toContain(run("a1").id);
    expect(ids(split.get("/wt/b"))).toContain(run("b1").id);
  });

  it("sends a file to the worktree that holds it, else to main, and the rest to the current one", () => {
    expect(ids(split.get("/wt/b"))).toEqual([fileTabId("/wt/b/src/x.ts"), run("b1").id]);
    expect(ids(split.get("/repo"))).toEqual([run("m1").id, fileTabId("/elsewhere/n.md"), run("gone").id]);
    expect(ids(split.get("/wt/a"))).toEqual([run("a1").id, "browser:x"]);
  });

  it("keeps the tab on screen active in its strip, and the others show their last", () => {
    expect(split.get("/wt/b")?.activeId).toBe(run("b1").id);
    expect(split.get("/repo")?.activeId).toBe(run("gone").id);
    expect(split.get("/wt/a")?.closed).toEqual([page("old")]);
    expect(split.get("/repo")?.closed).toEqual([]);
  });

  it("gives every worktree a strip, empty when nothing is its", () => {
    expect(splitStrip(strip([run("m1")]), paths, "/repo", placeOf).get("/wt/b")).toEqual({ ...strip([]), recent: [] });
  });

  it("gives each strip the recent order of its own tabs, and shows the one last used", () => {
    const used = { ...joined, recent: [run("a1").id, run("m1").id, "browser:x", run("gone").id] };
    const split = splitStrip(used, paths, "/wt/a", placeOf);
    expect(split.get("/repo")?.recent).toEqual([run("m1").id, run("gone").id]);
    expect(split.get("/repo")?.activeId).toBe(run("m1").id);
    expect(split.get("/wt/a")?.recent).toEqual([run("a1").id, "browser:x"]);
    expect(split.get("/wt/b")?.recent).toEqual([run("b1").id]);
  });
});

describe("tabPlace", () => {
  it("picks the deepest folder that holds a file", () => {
    const nested = [tree("/repo", true), tree("/repo/.worktrees/c")];
    expect(tabPlace(file("/repo/.worktrees/c/x.ts"), workspace, nested, [])).toBe("/repo/.worktrees/c");
    expect(tabPlace(file("/repo/.worktrees/cc/x.ts"), workspace, nested, [])).toBe("/repo");
  });

  it("gives pages, stubs and sessions it cannot find no worktree", () => {
    expect(tabPlace(page("x"), workspace, trees, sessions)).toBeNull();
    const stub: Tab = { id: stubTabId("sidechat"), kind: "stub", stub: "sidechat", title: "" };
    expect(tabPlace(stub, workspace, trees, sessions)).toBeNull();
    expect(tabPlace(run("nobody"), workspace, trees, sessions)).toBeNull();
  });
});

describe("a round trip", () => {
  it("splits back into the strips it joined", () => {
    const main = strip([run("m1"), file("/repo/README.md")], run("m1").id);
    const a = strip([page("x"), run("a1")], run("a1").id);
    const b = strip([file("/wt/b/x.ts"), run("b1")], run("b1").id);
    const joined = joinStrips([main, a, b], run("a1").id);
    const split = splitStrip(joined, paths, "/wt/a", placeOf);
    expect([...split.values()].map(ids)).toEqual([main, a, b].map(ids));
    expect(ids(joinStrips([...split.values()], joined.activeId))).toEqual(ids(joined));
    expect(split.get("/wt/a")?.activeId).toBe(run("a1").id);
  });
});
