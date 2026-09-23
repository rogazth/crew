import { describe, expect, it } from "vitest";
import {
  PARTITION,
  RESTORE_PREFIX,
  attachDecision,
  browserUserAgent,
  certificateBypass,
  createRateLimiter,
  hardenWebPreferences,
  navigationVerdict,
  permissionAllowed,
  popupVerdict,
} from "./policy";

describe("hardenWebPreferences", () => {
  it("overrides whatever the webview asked for", () => {
    const prefs: Record<string, unknown> = {
      preload: "/tmp/evil.js",
      preloadURL: "file:///tmp/evil.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: "ExperimentalThing",
      disableBlinkFeatures: "SomethingElse",
      webviewTag: true,
      partition: PARTITION,
    };
    hardenWebPreferences(prefs);
    expect(prefs).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableBlinkFeatures: "",
      webviewTag: false,
      partition: PARTITION,
    });
  });

  it("hardens an empty object the same way", () => {
    const prefs: Record<string, unknown> = {};
    hardenWebPreferences(prefs);
    expect(prefs).not.toHaveProperty("preload");
    expect(prefs).not.toHaveProperty("enableBlinkFeatures");
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  });
});

describe("attachDecision", () => {
  const attach = (src: string | undefined, partition = PARTITION) =>
    attachDecision(src === undefined ? { partition } : { src, partition });
  const allowed = { allow: true, restoreToken: null };
  const denied = { allow: false };

  it.each([
    ["no src", undefined],
    ["an empty src", ""],
    ["about:blank", "about:blank"],
    ["about:blank with a fragment", "about:blank#top"],
    ["about:blank with an upper-case scheme", "ABOUT:blank"],
    ["an http page", "http://localhost:3000/"],
    ["an https page", "https://example.com/a?b#c"],
    ["an upper-case scheme", "HTTPS://EXAMPLE.COM"],
  ])("allows %s", (_, src) => {
    expect(attach(src)).toEqual(allowed);
  });

  it.each([
    ["file:", "file:///etc/passwd"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://example.com/uuid"],
    ["an app scheme", "crew://settings"],
    ["chrome:", "chrome://settings"],
    ["view-source:", "view-source:https://example.com"],
    ["about:srcdoc", "about:srcdoc"],
    ["another about: page", "about:config"],
    ["about:blank with a query", "about:blank?x"],
    ["a relative path", "/index.html"],
    ["garbage", "not a url"],
    ["an http URL without a host", "http://"],
  ])("denies %s", (_, src) => {
    expect(attach(src)).toEqual(denied);
  });

  it("denies any other partition, including none", () => {
    expect(attachDecision({ src: "https://example.com" })).toEqual(denied);
    expect(attachDecision({})).toEqual(denied);
    expect(attach("https://example.com", "")).toEqual(denied);
    expect(attach("https://example.com", "persist:other")).toEqual(denied);
    expect(attach("https://example.com", "crew-browser")).toEqual(denied);
    expect(attach("about:blank", "persist:crew-browser2")).toEqual(denied);
  });

  it("hands back a restore token", () => {
    expect(attach(`${RESTORE_PREFIX}abc-123-DEF`)).toEqual({ allow: true, restoreToken: "abc-123-DEF" });
    const longest = "a".repeat(64);
    expect(attach(`${RESTORE_PREFIX}${longest}`)).toEqual({ allow: true, restoreToken: longest });
  });

  it.each([
    ["an empty token", ""],
    ["a token over 64 characters", "a".repeat(65)],
    ["a token with a slash", "abc/def"],
    ["a token with an underscore", "abc_def"],
    ["a token with a space", "abc def"],
    ["a token with a fragment", "abc#def"],
    ["a token with a newline", "abc\n"],
    ["a token with a percent escape", "abc%20"],
  ])("denies a restore src with %s", (_, token) => {
    expect(attach(`${RESTORE_PREFIX}${token}`)).toEqual(denied);
  });

  it("checks the partition before the restore token", () => {
    expect(attach(`${RESTORE_PREFIX}abc`, "persist:other")).toEqual(denied);
  });
});

describe("navigationVerdict", () => {
  it.each([
    "http://example.com",
    "https://example.com/path?q#frag",
    "HTTPS://EXAMPLE.COM",
    "Http://localhost:5173",
    "about:blank",
    "about:blank#frag",
  ])("allows %s", (url) => {
    expect(navigationVerdict(url)).toBe("allow");
  });

  it.each(["mailto:someone@example.com", "MAILTO:someone@example.com", "mailto:"])(
    "sends %s to the system",
    (url) => {
      expect(navigationVerdict(url)).toBe("external");
    },
  );

  it.each([
    "file:///etc/passwd",
    "FILE:///etc/passwd",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "blob:https://example.com/uuid",
    "crew://open",
    "vscode://file/x",
    "chrome://settings",
    "about:config",
    "about:srcdoc",
    "tel:+123",
    "ftp://example.com",
    "",
    "not a url",
    "http://",
  ])("blocks %s", (url) => {
    expect(navigationVerdict(url)).toBe("block");
  });
});

describe("popupVerdict", () => {
  const popup = (url: string, disposition: string, features = "") => popupVerdict({ url, disposition, features });
  const url = "https://example.com/login";

  it("opens a sized or explicit popup as a real window", () => {
    expect(popup(url, "new-window", "width=500,height=600")).toEqual({ action: "window" });
    expect(popup(url, "new-window", "height=600")).toEqual({ action: "window" });
    expect(popup(url, "new-window", "popup")).toEqual({ action: "window" });
    expect(popup(url, "new-window", "popup=yes")).toEqual({ action: "window" });
    expect(popup(url, "new-window", "left=10, Width = 400")).toEqual({ action: "window" });
    expect(popup(url, "new-window", "innerWidth=400")).toEqual({ action: "window" });
  });

  it("turns a new window without size into a foreground tab", () => {
    expect(popup(url, "new-window")).toEqual({ action: "tab", url, background: false });
    expect(popup(url, "new-window", "noopener,noreferrer")).toEqual({ action: "tab", url, background: false });
    expect(popup(url, "new-window", "left=10,top=10")).toEqual({ action: "tab", url, background: false });
  });

  it("opens a background tab without stealing focus", () => {
    expect(popup(url, "background-tab")).toEqual({ action: "tab", url, background: true });
  });

  it.each(["foreground-tab", "default", "other"])("opens %s as a foreground tab", (disposition) => {
    expect(popup(url, disposition)).toEqual({ action: "tab", url, background: false });
  });

  it("ignores features outside new-window", () => {
    expect(popup(url, "foreground-tab", "width=500")).toEqual({ action: "tab", url, background: false });
    expect(popup(url, "background-tab", "width=500")).toEqual({ action: "tab", url, background: true });
  });

  it("denies saving to disk and dispositions it does not know", () => {
    expect(popup(url, "save-to-disk")).toEqual({ action: "deny" });
    expect(popup(url, "new-popup-someday")).toEqual({ action: "deny" });
    expect(popup(url, "")).toEqual({ action: "deny" });
  });

  it("sends mailto to the system whatever the disposition", () => {
    expect(popup("mailto:a@b.c", "foreground-tab")).toEqual({ action: "external", url: "mailto:a@b.c" });
    expect(popup("MAILTO:a@b.c", "new-window", "width=1")).toEqual({ action: "external", url: "MAILTO:a@b.c" });
  });

  it("gives a sized blank popup a window, since a login navigates it afterwards", () => {
    expect(popup("about:blank", "new-window", "width=500,height=600")).toEqual({ action: "window" });
    expect(popup("about:blank", "new-window", "")).toEqual({ action: "deny" });
    expect(popup("about:blank", "foreground-tab")).toEqual({ action: "deny" });
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "crew://x",
    "",
    "not a url",
  ])("denies a popup to %s", (target) => {
    expect(popup(target, "new-window", "width=500")).toEqual({ action: "deny" });
    expect(popup(target, "foreground-tab")).toEqual({ action: "deny" });
  });

  it("keeps an upper-case http scheme", () => {
    expect(popup("HTTPS://EXAMPLE.COM/", "background-tab")).toEqual({
      action: "tab",
      url: "HTTPS://EXAMPLE.COM/",
      background: true,
    });
  });
});

describe("permissionAllowed", () => {
  it.each(["clipboard-sanitized-write", "fullscreen", "pointerLock"])("allows %s", (permission) => {
    expect(permissionAllowed(permission)).toBe(true);
  });

  it.each([
    "media",
    "geolocation",
    "notifications",
    "display-capture",
    "openExternal",
    "clipboard-read",
    "midi",
    "midiSysex",
    "hid",
    "serial",
    "usb",
    "idle-detection",
    "keyboardLock",
    "window-management",
    "storage-access",
    "top-level-storage-access",
    "speaker-selection",
    "fileSystem",
    "unknown",
    "",
    "Fullscreen",
    "pointerlock",
  ])("denies %s", (permission) => {
    expect(permissionAllowed(permission)).toBe(false);
  });
});

describe("certificateBypass", () => {
  it.each([
    "https://localhost/",
    "https://localhost:5173/app",
    "https://LOCALHOST:8443",
    "https://127.0.0.1/",
    "https://127.0.0.1:3000/x?y",
    "https://[::1]/",
    "https://[::1]:8443/",
    "https://[0:0:0:0:0:0:0:1]:8443/",
    "HTTPS://localhost/",
    "wss://localhost:5173/",
  ])("lets %s past a bad certificate", (url) => {
    expect(certificateBypass(url)).toBe(true);
  });

  it.each([
    "http://localhost/",
    "ws://localhost/",
    "wss://localhost.evil.com/",
    "https://localhost.evil.com/",
    "https://127.0.0.1.nip.io/",
    "https://evil.localhost.com/",
    "https://localhost@evil.com/",
    "https://evil.com/#@localhost",
    "https://evil.com/?localhost",
    "https://evil.com/localhost",
    "https://127.0.0.2/",
    "https://0.0.0.0/",
    "https://192.168.1.10/",
    "https://[::2]/",
    "https://[::ffff:127.0.0.1]/",
    "https://example.com/",
    "localhost:3000",
    "not a url",
    "",
  ])("keeps refusing %s", (url) => {
    expect(certificateBypass(url)).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("allows max actions per window and refuses the rest", () => {
    let t = 0;
    const allow = createRateLimiter(4, 2000, () => t);
    expect([allow(), allow(), allow(), allow(), allow()]).toEqual([true, true, true, true, false]);
    t = 1999;
    expect(allow()).toBe(false);
  });

  it("slides: each action frees its slot a window after it happened", () => {
    let t = 0;
    const allow = createRateLimiter(2, 1000, () => t);
    expect(allow()).toBe(true); // t=0
    t = 500;
    expect(allow()).toBe(true); // t=500
    expect(allow()).toBe(false);
    t = 1000;
    expect(allow()).toBe(true); // the t=0 slot is free; now 500 and 1000 are held
    expect(allow()).toBe(false);
    t = 1499;
    expect(allow()).toBe(false);
    t = 1500;
    expect(allow()).toBe(true);
  });

  it("does not count refused attempts", () => {
    let t = 0;
    const allow = createRateLimiter(1, 1000, () => t);
    expect(allow()).toBe(true);
    for (t = 100; t < 1000; t += 100) expect(allow()).toBe(false);
    t = 1000;
    expect(allow()).toBe(true);
  });

  it("refuses everything with no room", () => {
    const allow = createRateLimiter(0, 1000, () => 0);
    expect(allow()).toBe(false);
  });

  it("keeps separate limiters apart", () => {
    const a = createRateLimiter(1, 1000, () => 0);
    const b = createRateLimiter(1, 1000, () => 0);
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    expect(a()).toBe(false);
  });

  it("uses the real clock by default", () => {
    const allow = createRateLimiter(1, 60_000);
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });
});

describe("browserUserAgent", () => {
  // Electron 44.2's default, read from app.userAgentFallback.
  const linux =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Crew/0.1.4 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36";
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Crew/0.1.4 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36";

  it("leaves Chromium's own agent", () => {
    expect(browserUserAgent(linux)).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Safari/537.36",
    );
    expect(browserUserAgent(mac)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Safari/537.36",
    );
  });

  it("strips the app token in any case", () => {
    expect(browserUserAgent(linux.replace("Crew/", "crew/"))).not.toMatch(/crew/i);
    expect(browserUserAgent(linux.replace("Crew/0.1.4", "CREW/1.0.0-beta.2"))).not.toMatch(/crew/i);
  });

  it("keeps words that merely contain the app name", () => {
    expect(browserUserAgent("Mozilla/5.0 Screw/1.0 Chrome/152.0.0.0")).toBe("Mozilla/5.0 Screw/1.0 Chrome/152.0.0.0");
  });

  it("leaves an agent without the tokens alone", () => {
    const plain = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Safari/537.36";
    expect(browserUserAgent(plain)).toBe(plain);
  });
});
