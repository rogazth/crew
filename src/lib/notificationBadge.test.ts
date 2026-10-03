import { describe, expect, it } from "vitest";
import { attentionOf, NO_BADGE, nextBadge } from "./notificationBadge";

const row = (id: string, status: "idle" | "working" | "needs-input" | "done" | "error", notifications = true) => ({
  id,
  status,
  notifications,
});

describe("attentionOf", () => {
  it("is the sessions waiting on the user, muted ones left out", () => {
    const sessions = [row("a", "needs-input"), row("b", "done"), row("c", "working"), row("d", "error", false)];
    expect([...attentionOf(sessions)]).toEqual(["a", "b"]);
  });
});

describe("nextBadge", () => {
  it("counts what starts waiting while Crew is in the background", () => {
    const one = nextBadge(NO_BADGE, new Set(["a"]), false);
    expect(one.count).toBe(1);
    expect(nextBadge(one, new Set(["a", "b"]), false).count).toBe(2);
  });

  it("is zero in front, and what was seen there does not count later", () => {
    const front = nextBadge(NO_BADGE, new Set(["a"]), true);
    expect(front.count).toBe(0);
    const back = nextBadge(front, new Set(["a", "b"]), false);
    expect(back.count).toBe(1);
  });

  it("counts a session again once it waits again", () => {
    const seen = nextBadge(NO_BADGE, new Set(["a"]), true);
    const working = nextBadge(seen, new Set(), false);
    expect(nextBadge(working, new Set(["a"]), false).count).toBe(1);
  });
});
