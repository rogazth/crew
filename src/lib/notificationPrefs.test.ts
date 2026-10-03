import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ stateGet: async () => null, stateSet: async () => {} }));

const { DEFAULT_NOTIFICATION_PREFS, isPaused, parseNotificationPrefs, pauseEnd } = await import("./notificationPrefs");

describe("parseNotificationPrefs", () => {
  it("starts from the defaults", () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("not json")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("null")).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("keeps what was saved and fills in what was not", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ enabled: false, volume: 30, kinds: { done: { banner: false, sound: "tap" } } }),
    );
    expect(parsed.enabled).toBe(false);
    expect(parsed.volume).toBe(30);
    expect(parsed.kinds.done).toEqual({ banner: false, sound: "tap" });
    expect(parsed.kinds["needs-input"]).toEqual(DEFAULT_NOTIFICATION_PREFS.kinds["needs-input"]);
    expect(parsed.onlyWhenUnfocused).toBe(true);
  });

  it("drops what it does not know", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ volume: 400, customSound: 3, pausedUntil: "soon", kinds: { error: { banner: "yes", sound: "kazoo" } } }),
    );
    expect(parsed.volume).toBe(100);
    expect(parsed.customSound).toBeNull();
    expect(parsed.pausedUntil).toBeNull();
    expect(parsed.kinds.error).toEqual(DEFAULT_NOTIFICATION_PREFS.kinds.error);
  });
});

describe("do not disturb", () => {
  it("lasts an hour, or until eight tomorrow", () => {
    const now = new Date(2026, 9, 3, 22, 15);
    expect(pauseEnd("hour", now)).toBe(new Date(2026, 9, 3, 23, 15).getTime());
    expect(pauseEnd("tomorrow", now)).toBe(new Date(2026, 9, 4, 8, 0).getTime());
    expect(pauseEnd("tomorrow", new Date(2026, 9, 4, 0, 30))).toBe(new Date(2026, 9, 4, 8, 0).getTime());
  });

  it("is over once its time passes", () => {
    expect(isPaused({ ...DEFAULT_NOTIFICATION_PREFS, pausedUntil: 100 }, 99)).toBe(true);
    expect(isPaused({ ...DEFAULT_NOTIFICATION_PREFS, pausedUntil: 100 }, 100)).toBe(false);
    expect(isPaused(DEFAULT_NOTIFICATION_PREFS, 0)).toBe(false);
  });
});
