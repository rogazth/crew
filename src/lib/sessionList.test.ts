import { describe, expect, it } from "vitest";
import { applyUpdated } from "./sessionList";
import type { Session } from "./types";

const row = (id: string, fields: Partial<Session> = {}) => ({ id, name: id, status: "idle", ...fields }) as Session;

describe("applyUpdated", () => {
  it("takes the description a bot rewrote and keeps the window's status", () => {
    const held = row("a", { status: "working", description: "old" });
    expect(applyUpdated(held, row("a", { status: "idle", description: "new" }))).toMatchObject({
      status: "working",
      description: "new",
    });
  });

  it("takes the provider a new session switched to", () => {
    const held = row("a", { provider: "claude", name: "claude" });
    expect(applyUpdated(held, row("a", { provider: "codex", name: "codex" }))).toMatchObject({ provider: "codex", name: "codex" });
  });

  it("takes how far a child got and what the user read of it", () => {
    const lastEvent = { kind: "failed" as const, at: 5, cursor: 7 };
    const updated = applyUpdated(row("a", { cursor: 3, userSeen: 3 }), row("a", { cursor: 7, userSeen: 3, lastEvent }));
    expect(updated).toMatchObject({ cursor: 7, userSeen: 3, lastEvent });
  });
});
