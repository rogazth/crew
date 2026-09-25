import { describe, expect, it } from "vitest";
import type { Session, Workspace, Worktree } from "./types";
import { branchError, contextId, parseContext, sessionPath, shortBranch, worktreeOf } from "./worktrees";

const workspace: Workspace = { id: "ws", name: "crew", path: "/repo", createdAt: 0 };
const tree = (path: string, branch: string | null, main = false): Worktree => ({
  path,
  branch,
  main,
  add: 0,
  del: 0,
  dirty: 0,
});
const trees = [tree("/repo", "master", true), tree("/wt/feat", "feat/avatars")];
const session = (worktree: string | null) => ({ worktree }) as Session;

describe("contextId", () => {
  it("keeps the main checkout on the workspace's own strip", () => {
    expect(contextId(workspace, "/repo", "worktree")).toBe("ws");
  });

  it("gives any other worktree its own strip, unless tabs are kept together", () => {
    expect(contextId(workspace, "/wt/feat", "worktree")).toBe("ws@/wt/feat");
    expect(contextId(workspace, "/wt/feat", "all")).toBe("ws");
  });

  it("round-trips through parseContext", () => {
    expect(parseContext("ws@/wt/feat")).toEqual({ workspaceId: "ws", worktree: "/wt/feat" });
    expect(parseContext("ws")).toEqual({ workspaceId: "ws", worktree: null });
  });
});

describe("worktreeOf", () => {
  it("finds a session's worktree, falling back to the main checkout", () => {
    expect(sessionPath(session(null), workspace)).toBe("/repo");
    expect(worktreeOf(session("/wt/feat"), workspace, trees)?.branch).toBe("feat/avatars");
    expect(worktreeOf(session("/wt/gone"), workspace, trees)?.branch).toBe("master");
  });
});

describe("branch names", () => {
  it("shortens to the last segment", () => {
    expect(shortBranch(tree("/wt/feat", "feat/avatars"))).toBe("avatars");
    expect(shortBranch(tree("/wt/x", null))).toBe("Detached");
  });

  it("rejects what git would", () => {
    expect(branchError("feat/sidebar-v2")).toBeNull();
    expect(branchError("")).toBe("Branch is required");
    expect(branchError("has space")).not.toBeNull();
    expect(branchError("a..b")).not.toBeNull();
    expect(branchError("feat/")).not.toBeNull();
  });
});
