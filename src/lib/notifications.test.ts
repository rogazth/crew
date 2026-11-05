import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
const dismissNotifications = vi.fn();
const notificationStatus = vi.fn();
vi.mock("./host", () => ({
  notificationStatus: (...args: unknown[]) => notificationStatus(...args),
  notify: (...args: unknown[]) => notify(...args),
  dismissNotifications: (...args: unknown[]) => dismissNotifications(...args),
}));
const playSound = vi.fn();
vi.mock("./notificationSound", () => ({ playSound: (...args: unknown[]) => playSound(...args) }));
vi.mock("./client", () => ({
  client: {
    request: async (method: string, params: Record<string, unknown>) =>
      method === "settings_list" ? [] : method === "settings_set" ? { ...params, revision: 1, origin: "test" } : null,
    on: () => () => {},
  },
}));
vi.mock("./api", () => ({ stateGet: async () => null, stateSet: async () => {} }));
const showToast = vi.fn();
const closeToast = vi.fn();
vi.mock("./toasts", () => ({
  showToast: (...args: unknown[]) => showToast(...args),
  toastManager: { close: (...args: unknown[]) => closeToast(...args) },
}));

const {
  COOLDOWN_MS,
  dispatchNotification,
  markSeen,
  reserveCooldown,
  resetNotifications,
  setVisibleSession,
} = await import("./notifications");
const { DEFAULT_NOTIFICATION_PREFS, updateNotificationPrefs } = await import("./notificationPrefs");

const session = { id: "s1", workspaceId: "w1", notifications: true };
const done = { source: "done" as const, title: "Planner", body: "All green", session };

let focused = false;

function prefs(change: Partial<typeof DEFAULT_NOTIFICATION_PREFS>) {
  updateNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, ...change });
}

beforeEach(() => {
  focused = false;
  vi.stubGlobal("document", { hasFocus: () => focused });
  notify.mockReset();
  notify.mockResolvedValue("shown");
  notificationStatus.mockReset();
  notificationStatus.mockResolvedValue("unknown");
  playSound.mockReset();
  showToast.mockReset();
  resetNotifications();
  dismissNotifications.mockReset();
  closeToast.mockReset();
  prefs({});
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
  it("shows a silent banner that leads back to its session, and plays the kind's sound", async () => {
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledWith({
      title: "Planner",
      body: "All green",
      target: { workspaceId: "w1", sessionId: "s1" },
      silent: true,
    });
    expect(playSound).toHaveBeenCalledWith("pop-down", 70);
  });

  it("stays silent when macOS blocks the banner", async () => {
    notify.mockResolvedValue("blocked");
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "blocked" });
    expect(playSound).not.toHaveBeenCalled();
  });

  it("the test button stays silent too when blocked", async () => {
    focused = true;
    notify.mockResolvedValue("blocked");
    await dispatchNotification({ source: "test", title: "Crew", body: "Hi" });
    expect(playSound).not.toHaveBeenCalled();
  });

  it("in front and blocked, shows the toast without the sound", async () => {
    focused = true;
    notificationStatus.mockResolvedValue("blocked");
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
    expect(showToast).toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("in front, blocked and with toasts off, says it was blocked", async () => {
    focused = true;
    prefs({ toasts: false });
    notificationStatus.mockResolvedValue("blocked");
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "blocked" });
    expect(playSound).not.toHaveBeenCalled();
  });

  it("leaves the system sound to the banner", async () => {
    prefs({ kinds: { ...DEFAULT_NOTIFICATION_PREFS.kinds, done: { enabled: true, sound: "system" } } });
    await dispatchNotification(done);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ silent: false }));
    expect(playSound).not.toHaveBeenCalled();
  });

  it("does nothing with notifications off or the kind switched off", async () => {
    prefs({ enabled: false });
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "disabled" });
    prefs({ kinds: { ...DEFAULT_NOTIFICATION_PREFS.kinds, done: { enabled: false, sound: "pop-down" } } });
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "source-disabled" });
    expect(playSound).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });

  it("is quiet for a session with its notifications off", async () => {
    const result = await dispatchNotification({ ...done, session: { ...session, notifications: false } });
    expect(result).toEqual({ delivered: false, reason: "muted" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("is quiet for the session on screen while the window has focus", async () => {
    setVisibleSession("s1");
    focused = true;
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "suppressed-focus" });
    focused = false;
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
  });

  it("shows a toast for another session while the window is in front, not a banner", async () => {
    focused = true;
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
    expect(notify).not.toHaveBeenCalled();
    expect(playSound).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Planner",
      body: "All green",
      source: "done",
      target: { workspaceId: "w1", sessionId: "s1" },
    });
  });

  it("only plays the sound in front with toasts off", async () => {
    focused = true;
    prefs({ toasts: false });
    expect(await dispatchNotification(done)).toEqual({ delivered: true });
    expect(showToast).not.toHaveBeenCalled();
    expect(playSound).toHaveBeenCalled();
  });

  it("says a burst once", async () => {
    await dispatchNotification({ ...done, source: "bell", body: "ding" });
    expect(await dispatchNotification(done)).toEqual({ delivered: false, reason: "cooldown" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await dispatchNotification({ ...done, session: { ...session, id: "s2" } })).toEqual({ delivered: true });
  });

  it("lets the test button through every time, switches and all", async () => {
    prefs({ enabled: false });
    focused = true;
    const test = { source: "test" as const, title: "Crew", body: "Test" };
    await dispatchNotification(test);
    expect(await dispatchNotification(test)).toEqual({ delivered: true });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(playSound).toHaveBeenCalledWith("pop-up", 70);
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

describe("markSeen", () => {
  it("takes down a session's banners and toast once it is on screen in a focused window", () => {
    focused = true;
    setVisibleSession("s1");
    expect(dismissNotifications).toHaveBeenCalledWith("s1");
    expect(closeToast).toHaveBeenCalledWith("session:s1");
  });

  it("waits for the window to come to the front", () => {
    setVisibleSession("s1");
    expect(dismissNotifications).not.toHaveBeenCalled();
    focused = true;
    markSeen();
    expect(dismissNotifications).toHaveBeenCalledWith("s1");
  });

  it("leaves everything up while no session is on screen", () => {
    focused = true;
    setVisibleSession(null);
    expect(dismissNotifications).not.toHaveBeenCalled();
    expect(closeToast).not.toHaveBeenCalled();
  });
});
