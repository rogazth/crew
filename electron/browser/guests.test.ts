import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCommand } from "../../src/lib/keymap";

const electron = vi.hoisted(() => ({
  templates: [] as unknown[][],
  openExternal: vi.fn(),
  writeText: vi.fn(),
}));

class FakeContents extends EventEmitter {
  static next = 1;
  id = FakeContents.next++;
  destroyed = false;
  sent: [string, unknown][] = [];
  openHandler: ((details: unknown) => unknown) | null = null;
  navigationHistory = {
    restore: vi.fn(() => Promise.resolve()),
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  loadURL = vi.fn(() => Promise.resolve());
  session: unknown = null;
  isDestroyed = () => this.destroyed;
  send = (channel: string, value: unknown) => this.sent.push([channel, value]);
  setWindowOpenHandler = (handler: (details: unknown) => unknown) => {
    this.openHandler = handler;
  };
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

vi.mock("electron", () => {
  const ses = {
    setUserAgent: vi.fn(),
    getUserAgent: () => "Mozilla/5.0 Chrome/140 Electron/44.2.0 crew/0.1.4",
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  };
  return {
    app: { on: vi.fn(), getPath: () => "/tmp" },
    BrowserWindow: { fromWebContents: () => ({}) },
    clipboard: { writeText: electron.writeText },
    Menu: {
      buildFromTemplate: (template: unknown[]) => {
        electron.templates.push(template);
        return { popup: vi.fn() };
      },
    },
    Notification: { isSupported: () => false },
    session: { fromPartition: () => ses },
    shell: { openExternal: electron.openExternal, showItemInFolder: vi.fn() },
  };
});

type Guests = typeof import("./guests");

let guests: Guests;
let host: FakeContents;

/** What Electron hands will-attach-webview, and whether the attach was refused. */
function willAttach(params: { src?: string; partition?: string }) {
  const prefs: Record<string, unknown> = { preload: "/evil.js", nodeIntegration: true };
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  host.emit("will-attach-webview", event, prefs, params);
  return { prevented: event.prevented, prefs, params };
}

function didAttach(): FakeContents {
  const guest = new FakeContents();
  host.emit("did-attach-webview", {}, guest);
  return guest;
}

const PAGE = { partition: "persist:crew-browser" };
const SNAPSHOT = { entries: [{ url: "https://a.com/", title: "A" }, { url: "https://b.com/", title: "B" }], index: 0 };

beforeEach(async () => {
  vi.resetModules();
  electron.templates.length = 0;
  electron.openExternal.mockClear();
  guests = await import("./guests");
  host = new FakeContents();
  guests.installBrowser({ webContents: host } as never);
});

describe("attaching", () => {
  it("refuses a webview outside the partition or with a src it does not allow", () => {
    expect(willAttach({ partition: "persist:other", src: "https://a.com" }).prevented).toBe(true);
    expect(willAttach({ ...PAGE, src: "file:///etc/passwd" }).prevented).toBe(true);
    expect(willAttach({ ...PAGE, src: "https://a.com" }).prevented).toBe(false);
  });

  it("hardens what the element asked for", () => {
    const { prefs } = willAttach({ ...PAGE, src: "https://a.com" });
    expect(prefs.preload).toBeUndefined();
    expect(prefs).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
  });

  it("restores a stack on the guest the token came with, past refused attaches in between", () => {
    guests.prepareRestore("t1", SNAPSHOT);
    willAttach({ ...PAGE, src: "https://plain.com" });
    const plain = didAttach();
    willAttach({ partition: "persist:other" });
    const restoring = willAttach({ ...PAGE, src: "about:blank#crew-restore=t1" });
    expect(restoring.params.src).toBe("");
    const restored = didAttach();
    expect(plain.navigationHistory.restore).not.toHaveBeenCalled();
    expect(restored.navigationHistory.restore).toHaveBeenCalledWith(SNAPSHOT);
  });

  it("loads a blank page when the token's snapshot is gone", () => {
    const { params } = willAttach({ ...PAGE, src: "about:blank#crew-restore=missing" });
    expect(params.src).toBe("about:blank");
    expect(didAttach().navigationHistory.restore).not.toHaveBeenCalled();
  });

  it("falls back to the active URL when restore fails", async () => {
    guests.prepareRestore("t2", SNAPSHOT);
    willAttach({ ...PAGE, src: "about:blank#crew-restore=t2" });
    const guest = new FakeContents();
    guest.navigationHistory.restore = vi.fn(() => Promise.reject(new Error("no")));
    host.emit("did-attach-webview", {}, guest);
    await vi.waitFor(() => expect(guest.loadURL).toHaveBeenCalledWith("https://a.com/"));
  });
});

describe("the registry", () => {
  it("answers only the window that embeds a guest, and forgets it once destroyed", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(guests.ownedGuest(host as never, guest.id)).toBe(guest);
    expect(guests.ownedGuest(new FakeContents() as never, guest.id)).toBeNull();
    guest.destroy();
    expect(guests.ownedGuest(host as never, guest.id)).toBeNull();
  });
});

describe("keys inside a page", () => {
  const press = (guest: FakeContents, input: Partial<Record<string, unknown>>) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    guest.emit("before-input-event", event, {
      type: "keyDown",
      key: "l",
      code: "KeyL",
      meta: false,
      control: false,
      alt: false,
      shift: false,
      isAutoRepeat: false,
      isComposing: false,
      ...input,
    });
    return event.prevented;
  };
  const live: LiveCommand[] = [{ id: "browser-focus-address", keys: "Mod+L", repeat: false }];
  const mod = process.platform === "darwin" ? { meta: true } : { control: true };

  it("swallows a live chord and sends its command to the window", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guests.setLiveCommands(host as never, live);
    expect(press(guest, mod)).toBe(true);
    expect(host.sent).toContainEqual(["browser:command", "browser-focus-address"]);
  });

  it("leaves everything else to the page", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guests.setLiveCommands(host as never, live);
    expect(press(guest, {})).toBe(false);
    expect(press(guest, { ...mod, key: "e", code: "KeyE" })).toBe(false);
    expect(press(guest, { ...mod, isComposing: true })).toBe(false);
    expect(host.sent).toEqual([]);
  });

  it("swallows a held repeat without running it again", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guests.setLiveCommands(host as never, live);
    expect(press(guest, { ...mod, isAutoRepeat: true })).toBe(true);
    expect(host.sent).toEqual([]);
  });
});

describe("popups and navigation", () => {
  const open = (guest: FakeContents, url: string, disposition = "foreground-tab", features = "") =>
    guest.openHandler?.({ url, disposition, features, frameName: "", referrer: {} }) as { action: string };

  it("turns target=_blank into a tab beside its opener", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(open(guest, "https://b.com/", "background-tab").action).toBe("deny");
    expect(host.sent).toContainEqual(["browser:open-tab", { url: "https://b.com/", background: true, openerId: guest.id }]);
  });

  it("gives a login popup a window in the same partition", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const answer = open(guest, "https://login.com/", "new-window", "width=400") as unknown as {
      action: string;
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    expect(answer.action).toBe("allow");
    expect(answer.overrideBrowserWindowOptions.webPreferences).toMatchObject({
      partition: "persist:crew-browser",
      sandbox: true,
      nodeIntegration: false,
    });
  });

  it("stops a page that keeps opening windows", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const answers = Array.from({ length: 10 }, () => open(guest, "https://spam.com/"));
    expect(answers.every((answer) => answer.action === "deny")).toBe(true);
    expect(host.sent.filter(([channel]) => channel === "browser:open-tab")).toHaveLength(4);
  });

  it("blocks navigations off the web, in the page and in its popups", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const navigate = (contents: FakeContents, url: string) => {
      const event = { url, prevented: false, preventDefault() { this.prevented = true; } };
      contents.emit("will-navigate", event);
      return event.prevented;
    };
    expect(navigate(guest, "https://b.com/")).toBe(false);
    expect(navigate(guest, "file:///etc/passwd")).toBe(true);
    expect(navigate(guest, "mailto:a@b.c")).toBe(true);
    expect(electron.openExternal).toHaveBeenCalledWith("mailto:a@b.c");
    const popup = new FakeContents();
    guest.emit("did-create-window", { webContents: popup });
    expect(navigate(popup, "javascript:alert(1)")).toBe(true);
  });
});

describe("the context menu", () => {
  const params = {
    x: 1,
    y: 2,
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  };
  const labels = () =>
    (electron.templates.at(-1) as { label?: string; role?: string; type?: string }[]).map(
      (item) => item.label ?? item.role ?? item.type,
    );

  it("offers link actions for a web link and none for a javascript: one", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, linkURL: "https://b.com/" });
    expect(labels()).toContain("Open Link in New Tab");
    guest.emit("context-menu", {}, { ...params, linkURL: "javascript:alert(1)" });
    expect(labels()).not.toContain("Open Link in New Tab");
  });

  it("offers editing roles in a field, and always back, forward, reload and inspect", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, isEditable: true });
    expect(labels()).toEqual(
      expect.arrayContaining(["cut", "copy", "paste", "selectAll", "Back", "Forward", "Reload", "Inspect Element"]),
    );
  });
});

describe("stress", () => {
  it("leaves the registry empty after 1,000 attach and destroy cycles", () => {
    const ids: number[] = [];
    for (let i = 0; i < 1000; i++) {
      willAttach({ ...PAGE, src: "https://a.com" });
      const guest = didAttach();
      ids.push(guest.id);
      guest.destroy();
    }
    expect(ids.every((id) => guests.ownedGuest(host as never, id) === null)).toBe(true);
  });
});
