import { describe, expect, it } from "vitest";
import { isDerivedName, stillBlank } from "./blankSessions";
import type { Session } from "./types";

const row = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  workspaceId: "w",
  kind: "terminal",
  name: "claude",
  provider: "claude",
  model: "",
  effort: "",
  providerSessionId: null,
  worktree: null,
  description: "",
  notifications: true,
  autonomy: "full",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe("isDerivedName", () => {
  it("takes the provider and a number, nothing else", () => {
    expect(isDerivedName("codex", "codex")).toBe(true);
    expect(isDerivedName("codex 12", "codex")).toBe(true);
    expect(isDerivedName("codex 2b", "codex")).toBe(false);
    expect(isDerivedName("codex ", "codex")).toBe(false);
    expect(isDerivedName("codexer", "codex")).toBe(false);
    expect(isDerivedName("Refactor", "codex")).toBe(false);
  });
});

describe("stillBlank", () => {
  it("keeps a session nothing was said in, whatever CLI it switched to", () => {
    const blank = new Set(["a", "b"]);
    const kept = stillBlank(blank, [row("a", { status: "starting" }), row("b", { provider: "codex", name: "codex 2" })]);
    expect(kept).toBe(blank);
  });

  it("lets go of one that took a turn, one renamed, and one that started another", () => {
    const kept = stillBlank(new Set(["a", "b", "c", "e"]), [
      row("a", { status: "working" }),
      row("b", { name: "Login work" }),
      row("c", { status: "exited" }),
      row("e"),
      row("kid", { kind: "child", name: "Lint pass", parentId: "e" }),
    ]);
    expect([...kept]).toEqual(["c"]);
  });

  it("holds one the list has not caught up with", () => {
    const blank = new Set(["a"]);
    expect(stillBlank(blank, [])).toBe(blank);
  });
});
