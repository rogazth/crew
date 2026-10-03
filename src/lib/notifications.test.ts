import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
vi.mock("./host", () => ({ notify: (...args: unknown[]) => notify(...args) }));

const { COOLDOWN_MS, dispatchNotification, reserveCooldown, resetNotifications, setVisibleSession } = await import(
  "./notifications"
);

const session = { id: "s1", workspaceId: "w1", notifications: true };
const done = { source: "done" as const, title: "Planner", body: "All green", session };

let focused = true;

beforeEach(() => {
  focused = true;
  vi.stubGlobal("document", { hasFocus: () => focused });
  notify.mockReset();
  notify.mockResolvedValue("shown");
  resetNotifications();
});

describe("reserveCooldown", () => {
  it("lets the same key through once per window", () => {
    const seen = new Map<string, number>();
    expect(reserveCooldown(seen, "a", 0)).toBe(true);
    expect(reserveCooldown(seen, "a", COOLDOWN_MS - 1)).toBe(false);
    expect(reserveCooldown(seen, "b", 1)).toBe(true);
    expect(reserveCooldown(seen, "a", COOLDOWN_MS)).toBe(true);
  });

  it("keeps the map small", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 200; i += 1) reserveCooldown(seen, `k${i}`, i);
    expect(seen.size).toBeLessThanOrEqual(50);
    expect(seen.has("k199")).toBe(true);
  });
});

describe("dispatchNotification", () => {
  it("shows a banner that leads back to its session", async () => {
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledWith({
      title: "Planner",
      body: "All green",
      target: { workspaceId: "w1", sessionId: "s1" },
    });
  });

  it("is quiet for a session with its notifications off", async () => {
    const result = await dispatchNotification({ ...done, session: { ...session, notifications: false } });
    expect(result).toEqual({ delivered: false, reason: "muted" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("is quiet for the session on screen while the window has focus", async () => {
    setVisibleSession("s1");
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "suppressed-focus" });
    focused = false;
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
  });

  it("says a burst once", async () => {
    await dispatchNotification({ ...done, source: "bell", body: "ding" });
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "cooldown" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await dispatchNotification({ ...done, session: { ...session, id: "s2" } })).toEqual({ delivered: true });
  });

  it("lets the test button through every time", async () => {
    const test = { source: "test" as const, title: "Crew", body: "Test" };
    await dispatchNotification(test);
    expect(await dispatchNotification(test)).toEqual({ delivered: true });
  });

  it("reports macOS blocking it", async () => {
    notify.mockResolvedValue("blocked");
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "blocked" });
  });

  it("cuts a long body down to a glance", async () => {
    await dispatchNotification({ ...done, body: "x".repeat(500) });
    expect(notify.mock.calls[0]?.[0].body).toHaveLength(200);
  });
});
