import { describe, expect, it } from "vitest";
import { deferred } from "../test/deferred";
import { activeSessionIdOf, removeWorkspaceInOrder, togglePaletteMode, withModel } from "./app";
import type { Session } from "./types";

describe("togglePaletteMode", () => {
  it("opens a mode when nothing is open", () => {
    expect(togglePaletteMode(null, "files")).toBe("files");
  });

  it("closes the palette when its own mode is asked for again", () => {
    expect(togglePaletteMode("files", "files")).toBeNull();
  });

  it("switches to another mode instead of closing", () => {
    expect(togglePaletteMode("files", "agents")).toBe("agents");
  });
});

describe("activeSessionIdOf", () => {
  it("names the session of a session tab", () => {
    expect(activeSessionIdOf({ id: "session:s1", kind: "session", sessionId: "s1" })).toBe("s1");
  });

  it("is null for a file tab, a stub tab and no tab", () => {
    expect(activeSessionIdOf({ id: "file:/a", kind: "file", path: "/a", relative: "a" })).toBeNull();
    expect(activeSessionIdOf({ id: "stub:terminal", kind: "stub", stub: "terminal", title: "Terminal" })).toBeNull();
    expect(activeSessionIdOf(null)).toBeNull();
  });
});

describe("withModel", () => {
  it("swaps the provider and model and keeps everything else", () => {
    const session = { id: "s1", name: "Ada", provider: "claude", model: "opus" } as Session;
    const next = withModel(session, "codex", "gpt");
    expect(next).toEqual({ id: "s1", name: "Ada", provider: "codex", model: "gpt" });
    expect(session.provider).toBe("claude");
  });
});

describe("removeWorkspaceInOrder", () => {
  it("drops the tabs, then the sessions, then waits for the delete", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    const done = removeWorkspaceInOrder("w1", {
      forgetTabs: (id) => order.push(`tabs ${id}`),
      forgetSessions: (id) => order.push(`sessions ${id}`),
      deleteWorkspace: (id) => {
        order.push(`delete ${id}`);
        return gate.promise;
      },
    });
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(order).toEqual(["tabs w1", "sessions w1", "delete w1"]);
    expect(settled).toBe(false);
    gate.resolve();
    await done;
    expect(settled).toBe(true);
  });

  it("passes a failed delete on to the caller", async () => {
    await expect(
      removeWorkspaceInOrder("w1", {
        forgetTabs: () => undefined,
        forgetSessions: () => undefined,
        deleteWorkspace: () => Promise.reject(new Error("busy")),
      }),
    ).rejects.toThrow("busy");
  });
});
