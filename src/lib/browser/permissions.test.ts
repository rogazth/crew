import { describe, expect, it } from "vitest";
import {
  alwaysAllowed,
  decide,
  externalScheme,
  forget,
  originOf,
  parseSitePermissions,
  permissionKinds,
  verdict,
} from "./permissions";

describe("alwaysAllowed", () => {
  it.each(["clipboard-sanitized-write", "fullscreen", "pointerLock"])("grants %s", (permission) => {
    expect(alwaysAllowed(permission)).toBe(true);
  });

  it.each(["media", "notifications", "geolocation", "openExternal", "midi", "usb", "Fullscreen", ""])(
    "never grants %s unasked",
    (permission) => {
      expect(alwaysAllowed(permission)).toBe(false);
    },
  );
});

describe("permissionKinds", () => {
  it("splits a media request into the devices it names", () => {
    expect(permissionKinds("media", ["video"])).toEqual(["camera"]);
    expect(permissionKinds("media", ["audio"])).toEqual(["microphone"]);
    expect(permissionKinds("media", ["video", "audio"])).toEqual(["camera", "microphone"]);
    expect(permissionKinds("media", "audio")).toEqual(["microphone"]);
  });

  it("asks for both when a media request names neither", () => {
    expect(permissionKinds("media")).toEqual(["camera", "microphone"]);
    expect(permissionKinds("media", [])).toEqual(["camera", "microphone"]);
  });

  it("maps the rest one to one", () => {
    expect(permissionKinds("notifications")).toEqual(["notifications"]);
    expect(permissionKinds("geolocation")).toEqual(["geolocation"]);
    expect(permissionKinds("clipboard-read")).toEqual(["clipboard-read"]);
  });

  it.each(["midi", "usb", "hid", "serial", "display-capture", "openExternal", "idle-detection", "unknown"])(
    "offers nothing for %s",
    (permission) => {
      expect(permissionKinds(permission)).toBeNull();
    },
  );
});

describe("originOf", () => {
  it("keys a web page by its origin", () => {
    expect(originOf("https://meet.google.com/abc-def?x=1")).toBe("https://meet.google.com");
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
  });

  it.each([null, undefined, "", "about:blank", "file:///x", "crew-file://a/b", "nope"])("has none for %s", (url) => {
    expect(originOf(url)).toBeNull();
  });
});

describe("verdict", () => {
  const site = "https://meet.example.com";

  it("asks about everything the site has no answer for", () => {
    expect(verdict({}, site, ["camera", "microphone"])).toEqual({ answer: "ask", kinds: ["camera", "microphone"] });
  });

  it("grants only when every kind was allowed", () => {
    const decisions = { [site]: { camera: "allow" as const } };
    expect(verdict(decisions, site, ["camera"])).toEqual({ answer: "allow" });
    expect(verdict(decisions, site, ["camera", "microphone"])).toEqual({
      answer: "ask",
      kinds: ["camera", "microphone"],
    });
  });

  it("refuses when any kind was blocked", () => {
    const decisions = { [site]: { camera: "allow" as const, microphone: "block" as const } };
    expect(verdict(decisions, site, ["camera", "microphone"])).toEqual({ answer: "block" });
  });

  it("keeps one site's answers to itself", () => {
    expect(verdict({ [site]: { camera: "allow" } }, "https://other.com", ["camera"]).answer).toBe("ask");
  });
});

describe("decide and forget", () => {
  const site = "https://a.com";

  it("sets decisions without touching the map it was given", () => {
    const before = { [site]: { camera: "block" as const } };
    const after = decide(before, site, ["camera", "microphone"], "allow");
    expect(after).toEqual({ [site]: { camera: "allow", microphone: "allow" } });
    expect(before).toEqual({ [site]: { camera: "block" } });
  });

  it("forgets one decision, and the site once it has none", () => {
    const decisions = { [site]: { camera: "allow" as const, geolocation: "block" as const } };
    expect(forget(decisions, site, "camera")).toEqual({ [site]: { geolocation: "block" } });
    expect(forget(forget(decisions, site, "camera"), site, "geolocation")).toEqual({});
    expect(forget(decisions, site)).toEqual({});
  });
});

describe("parseSitePermissions", () => {
  it("keeps well-formed decisions from JSON or an object", () => {
    const value = { "https://a.com": { camera: "allow", notifications: "block" } };
    expect(parseSitePermissions(JSON.stringify(value))).toEqual(value);
    expect(parseSitePermissions(value)).toEqual(value);
  });

  it("drops what isn't a web origin, a known permission or a decision", () => {
    expect(
      parseSitePermissions({
        "https://a.com/path": { camera: "allow" },
        "file:///x": { camera: "allow" },
        "https://b.com": { camera: "maybe", midi: "allow", geolocation: "block" },
        "https://c.com": "allow",
        "https://d.com": {},
      }),
    ).toEqual({ "https://b.com": { geolocation: "block" } });
  });

  it.each([null, "", "not json", "[]", 42, [1, 2]])("reads %s as nothing decided", (value) => {
    expect(parseSitePermissions(value)).toEqual({});
  });
});

describe("externalScheme", () => {
  it.each([
    ["zoommtg://zoom.us/join?confno=1", "zoommtg"],
    ["SLACK://open", "slack"],
    ["vscode://file/x", "vscode"],
    ["msteams:/l/meetup-join/x", "msteams"],
    ["tel:+123", "tel"],
    ["web+app:x", "web+app"],
  ])("offers %s to its app", (url, scheme) => {
    expect(externalScheme(url)).toBe(scheme);
  });

  it.each([
    "https://a.com",
    "http://a.com",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "blob:https://a.com/x",
    "about:blank",
    "chrome://settings",
    "devtools://x",
    "view-source:https://a.com",
    "",
    "no scheme",
  ])("never hands %s to an app", (url) => {
    expect(externalScheme(url)).toBeNull();
  });

  it("never hands over the caller's own schemes", () => {
    expect(externalScheme("crew-file://a/b", ["crew-file"])).toBeNull();
    expect(externalScheme("CREW://x", ["crew:"])).toBeNull();
    expect(externalScheme("zoommtg://x", ["crew"])).toBe("zoommtg");
  });
});
