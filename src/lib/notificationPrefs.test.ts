import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  client: {
    request: async (method: string, params: Record<string, unknown>) =>
      method === "settings_list" ? [] : method === "settings_set" ? { ...params, revision: 1, origin: "test" } : null,
    on: () => () => {},
  },
}));
vi.mock("./api", () => ({ stateGet: async () => null, stateSet: async () => {} }));

const { DEFAULT_NOTIFICATION_PREFS, parseNotificationPrefs } = await import("./notificationPrefs");

describe("parseNotificationPrefs", () => {
  it("starts from the defaults", () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("not json")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("null")).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("keeps what was saved and fills in what was not", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ enabled: false, volume: 30, kinds: { done: { enabled: false, sound: "bubble" } } }),
    );
    expect(parsed.enabled).toBe(false);
    expect(parsed.volume).toBe(30);
    expect(parsed.kinds.done).toEqual({ enabled: false, sound: "bubble" });
    expect(parsed.kinds["needs-input"]).toEqual(DEFAULT_NOTIFICATION_PREFS.kinds["needs-input"]);
  });

  it("keeps a sound saved under its old name as the pop that replaced it", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ kinds: { done: { enabled: true, sound: "ping" }, error: { enabled: true, sound: "tap" } } }),
    );
    expect(parsed.kinds.done.sound).toBe("pop-up");
    expect(parsed.kinds.error.sound).toBe("bubble");
  });

  it("turns a saved custom sound into the event's default", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ customSound: "/a.wav", kinds: { error: { enabled: false, sound: "custom" } } }),
    );
    expect(parsed).not.toHaveProperty("customSound");
    expect(parsed.kinds.error).toEqual({ enabled: false, sound: DEFAULT_NOTIFICATION_PREFS.kinds.error.sound });
  });

  it("reads a switch saved under its old name", () => {
    const parsed = parseNotificationPrefs(JSON.stringify({ kinds: { done: { banner: false, sound: "bubble" } } }));
    expect(parsed.kinds.done).toEqual({ enabled: false, sound: "bubble" });
  });

  it("drops what it does not know", () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({ volume: 400, pausedUntil: 1_800_000_000_000, kinds: { error: { enabled: "yes", sound: "kazoo" } } }),
    );
    expect(parsed.volume).toBe(100);
    expect(parsed).not.toHaveProperty("pausedUntil");
    expect(parsed.kinds.error).toEqual(DEFAULT_NOTIFICATION_PREFS.kinds.error);
  });
});
