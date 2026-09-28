import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCommand } from "../../src/lib/keymap";

const electron = vi.hoisted(() => ({
  sessionHandlers: new Map<string, (...args: unknown[]) => void>(),
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  partitions: [] as string[],
  templates: [] as unknown[][],
  openExternal: vi.fn(),
  writeText: vi.fn(),
  clearStorageData: vi.fn(() => Promise.resolve()),
  lastSession: null as unknown,
  permissionRequest: null as null | ((...args: unknown[]) => void),
  permissionCheck: null as null | ((...args: unknown[]) => boolean),
  headers: null as null | ((details: unknown, callback: (response: unknown) => void) => void),
  appForProtocol: vi.fn((_url: string) => "zoom.us.app"),
  mediaStatus: "granted" as string,
  askForMediaAccess: vi.fn(() => Promise.resolve(true)),
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
  downloadURL = vi.fn();
  print = vi.fn();
  url = "https://a.com/";
  getURL = () => this.url;
  getUserAgent = () => "Chrome";
  setUserAgent = vi.fn();
  session: unknown = { getUserAgent: () => "Chrome" };
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
    setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => {
      electron.permissionRequest = handler;
    },
    setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) => {
      electron.permissionCheck = handler;
    },
    setDisplayMediaRequestHandler: vi.fn(),
    webRequest: {
      onBeforeSendHeaders: (handler: (details: unknown, callback: (response: unknown) => void) => void) => {
        electron.headers = handler;
      },
    },
    on: (name: string, handler: (...args: unknown[]) => void) => electron.sessionHandlers.set(name, handler),
    clearStorageData: electron.clearStorageData,
    clearCache: vi.fn(() => Promise.resolve()),
    clearAuthCache: vi.fn(() => Promise.resolve()),
    clearHostResolverCache: vi.fn(() => Promise.resolve()),
    closeAllConnections: vi.fn(() => Promise.resolve()),
  };
  return {
    app: {
      on: (name: string, handler: (...args: unknown[]) => void) => electron.appHandlers.set(name, handler),
      getPath: () => "/tmp",
      getApplicationNameForProtocol: electron.appForProtocol,
    },
    BrowserWindow: { fromWebContents: () => ({ isFocused: () => true }) },
    clipboard: { writeText: electron.writeText },
    Menu: {
      buildFromTemplate: (template: unknown[]) => {
        electron.templates.push(template);
        return { popup: vi.fn() };
      },
    },
    Notification: { isSupported: () => false },
    session: {
      fromPartition: (partition: string) => {
        electron.partitions.push(partition);
        electron.lastSession = ses;
        return ses;
      },
    },
    shell: { openExternal: electron.openExternal, showItemInFolder: vi.fn(), openPath: vi.fn(() => Promise.resolve("")) },
    systemPreferences: {
      getMediaAccessStatus: () => electron.mediaStatus,
      askForMediaAccess: electron.askForMediaAccess,
    },
  };
});

type Guests = typeof import("./guests");

let guests: Guests;
let host: FakeContents;

/** What Electron hands will-attach-webview, and whether the attach was refused. */
function willAttach(params: { src?: string; partition?: string; preload?: string }) {
  // partition here is the merged webPreferences, after webpreferences= has spread over the attribute.
  const prefs: Record<string, unknown> = { preload: "/evil.js", nodeIntegration: true, partition: "persist:evil" };
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  host.emit("will-attach-webview", event, prefs, params);
  return { prevented: event.prevented, prefs, params };
}

function didAttach(): FakeContents {
  const guest = new FakeContents();
  host.emit("did-attach-webview", {}, guest);
  return guest;
}

const PAGE = { partition: "persist:crew-browser-ws-w1" };
const INCOGNITO = { partition: "crew-incognito-ws-w1" };
const SNAPSHOT = { entries: [{ url: "https://a.com/", title: "A" }, { url: "https://b.com/", title: "B" }], index: 0 };

beforeEach(async () => {
  vi.resetModules();
  electron.appHandlers.clear();
  electron.mediaStatus = "granted";
  electron.appForProtocol.mockClear();
  electron.appForProtocol.mockImplementation(() => "zoom.us.app");
  electron.templates.length = 0;
  electron.partitions.length = 0;
  electron.openExternal.mockClear();
  electron.clearStorageData.mockClear();
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

  it("gives each workspace its own session, set up once", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    willAttach({ ...PAGE, src: "https://b.com" });
    const other = willAttach({ partition: "persist:crew-browser-ws-w2", src: "https://a.com" });
    expect(other.prefs.partition).toBe("persist:crew-browser-ws-w2");
    expect(electron.partitions).toEqual(["persist:crew-browser-ws-w1", "persist:crew-browser-ws-w2"]);
  });

  it("refuses the shared partition from before workspaces had their own", () => {
    expect(willAttach({ partition: "persist:crew-browser", src: "https://a.com" }).prevented).toBe(true);
  });

  it("hardens what the element asked for", () => {
    const attached = willAttach({ ...PAGE, src: "https://a.com", preload: "/evil-attr.js" });
    expect(attached.params.preload).toBeUndefined();
    expect(attached.prefs.preload).toMatch(/guest-preload\.cjs$/);
    expect(attached.prefs.preload).not.toBe("/evil.js");
    expect(attached.prefs).toMatchObject({
      partition: "persist:crew-browser-ws-w1",
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    });
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
    expect(host.sent).toContainEqual([
      "browser:open-tab",
      { url: "https://b.com/", background: true, openerId: guest.id, incognito: false },
    ]);
  });

  it("keeps an incognito page's new tabs and login popups incognito", () => {
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    const guest = didAttach();
    open(guest, "https://b.com/", "foreground-tab");
    expect(host.sent).toContainEqual([
      "browser:open-tab",
      { url: "https://b.com/", background: false, openerId: guest.id, incognito: true },
    ]);
    const answer = open(guest, "https://login.com/", "new-window", "width=400") as unknown as {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    expect(answer.overrideBrowserWindowOptions.webPreferences.partition).toBe("crew-incognito-ws-w1");
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
      partition: "persist:crew-browser-ws-w1",
      sandbox: true,
      nodeIntegration: false,
    });
    // Only the sign-in disguise: the close guard would keep the popup from closing itself.
    expect(answer.overrideBrowserWindowOptions.webPreferences.preload).toMatch(/popup-preload\.cjs$/);
  });

  it("keeps a login popup in its own workspace's partition", () => {
    willAttach({ partition: "persist:crew-browser-ws-w2", src: "https://a.com" });
    const guest = didAttach();
    const answer = open(guest, "https://login.com/", "new-window", "width=400") as unknown as {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    expect(answer.overrideBrowserWindowOptions.webPreferences.partition).toBe("persist:crew-browser-ws-w2");
  });

  it("stops a page that keeps opening windows", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const answers = Array.from({ length: 10 }, () => open(guest, "https://spam.com/"));
    expect(answers.every((answer) => answer.action === "deny")).toBe(true);
    expect(host.sent.filter(([channel]) => channel === "browser:open-tab")).toHaveLength(4);
  });

  it("guards a popup's own popups, however deep", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const first = new FakeContents();
    guest.emit("did-create-window", { webContents: first });
    const second = new FakeContents();
    first.emit("did-create-window", { webContents: second });
    expect(second.openHandler).not.toBeNull();
    const event = { url: "file:///etc/passwd", prevented: false, preventDefault() { this.prevented = true; } };
    second.emit("will-navigate", event);
    expect(event.prevented).toBe(true);
  });

  it("holds mailto to the same budget as windows", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    for (let i = 0; i < 10; i++) open(guest, "mailto:a@b.c");
    expect(electron.openExternal).toHaveBeenCalledTimes(4);
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

  const click = (label: string) =>
    (electron.templates.at(-1) as { label?: string; click?: () => void }[]).find((item) => item.label === label)?.click?.();

  it("opens a link in an incognito tab from a regular page", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, linkURL: "https://b.com/" });
    click("Open Link in Incognito Tab");
    expect(host.sent).toContainEqual([
      "browser:open-tab",
      { url: "https://b.com/", background: true, openerId: guest.id, incognito: true },
    ]);
  });

  it("offers no second incognito item on an incognito page, whose new tabs are incognito already", () => {
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, linkURL: "https://b.com/" });
    expect(labels()).not.toContain("Open Link in Incognito Tab");
    click("Open Link in New Tab");
    expect(host.sent).toContainEqual([
      "browser:open-tab",
      { url: "https://b.com/", background: true, openerId: guest.id, incognito: true },
    ]);
  });

  it("offers editing roles in a field, and always back, forward, reload, print and inspect", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, isEditable: true });
    expect(labels()).toEqual(
      expect.arrayContaining(["cut", "copy", "paste", "selectAll", "Back", "Forward", "Reload", "Print…", "Inspect Element"]),
    );
    click("Print…");
    expect(guest.print).toHaveBeenCalled();
  });

  it("saves a link with a dialog, and sends one to the default browser", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, linkURL: "https://b.com/file.zip" });
    click("Save Link As…");
    expect(guest.downloadURL).toHaveBeenCalledWith("https://b.com/file.zip");
    const item = downloadItem("https://b.com/file.zip");
    electron.sessionHandlers.get("will-download")?.({}, item, guest);
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: "/tmp/evil.sh" });
    expect(item.setSavePath).not.toHaveBeenCalled();
    click("Open Link in Default Browser");
    expect(electron.openExternal).toHaveBeenCalledWith("https://b.com/file.zip");
  });

  it("offers to open and save an image", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("context-menu", {}, { ...params, mediaType: "image", hasImageContents: true, srcURL: "https://a.com/i.png" });
    expect(labels()).toEqual(expect.arrayContaining(["Open Image in New Tab", "Save Image As…", "Copy Image"]));
    click("Open Image in New Tab");
    expect(host.sent).toContainEqual([
      "browser:open-tab",
      { url: "https://a.com/i.png", background: true, openerId: guest.id, incognito: false },
    ]);
    guest.emit("context-menu", {}, { ...params, mediaType: "image", hasImageContents: true, srcURL: "data:image/png;base64,AA" });
    expect(labels()).not.toContain("Open Image in New Tab");
    expect(labels()).toContain("Save Image As…");
  });
});

describe("incognito sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("wipes the session a moment after its last page goes, not before", async () => {
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    const first = didAttach();
    willAttach({ ...INCOGNITO, src: "https://b.com" });
    const second = didAttach();
    first.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(electron.clearStorageData).not.toHaveBeenCalled();
    second.destroy();
    await vi.advanceTimersByTimeAsync(999);
    expect(electron.clearStorageData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(electron.clearStorageData).toHaveBeenCalledTimes(1);
  });

  it("keeps the session when a page is rebuilt right after its guest goes", async () => {
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    didAttach().destroy();
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    didAttach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(electron.clearStorageData).not.toHaveBeenCalled();
  });

  it("never wipes a workspace's saved session", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    didAttach().destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(electron.clearStorageData).not.toHaveBeenCalled();
  });
});

function downloadItem(url = "https://a.com/f.zip") {
  const item = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let state = "progressing";
  Object.assign(item, {
    getFilename: () => "../../evil.sh",
    getURL: () => url,
    setSavePath: vi.fn(),
    setSaveDialogOptions: vi.fn(),
    getSavePath: () => "/tmp/evil.sh",
    getReceivedBytes: () => 10,
    getTotalBytes: () => 20,
    getState: () => state,
    isPaused: () => false,
    canResume: () => false,
    cancel: vi.fn(),
    finish: (next: string) => {
      state = next;
      item.emit("done", {}, next);
    },
  });
  return item as typeof item & { finish: (state: string) => void };
}

describe("downloads", () => {
  const reports = () =>
    host.sent.filter(([channel]) => channel === "browser:downloads").map(([, info]) => info as Record<string, unknown>);

  it("reports a page's download to its window, saved under Downloads with a safe name", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const item = downloadItem();
    electron.sessionHandlers.get("will-download")?.({}, item, guest);
    expect(item.setSavePath).toHaveBeenCalledWith("/tmp/evil.sh");
    item.finish("completed");
    const sent = reports();
    expect(sent[0]).toMatchObject({ webContentsId: guest.id, filename: "evil.sh", state: "progressing" });
    expect(sent.at(-1)).toMatchObject({ webContentsId: guest.id, state: "completed", received: 10, total: 20 });
    expect(new Set(sent.map((info) => info.id)).size).toBe(1);
  });

  it("credits a login popup's download to the page that opened it", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const popup = new FakeContents();
    guest.emit("did-create-window", { webContents: popup });
    electron.sessionHandlers.get("will-download")?.({}, downloadItem(), popup);
    expect(reports()[0]).toMatchObject({ webContentsId: guest.id });
  });

  it("cancels a burst of downloads", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const items = Array.from({ length: 15 }, () => downloadItem());
    for (const item of items) electron.sessionHandlers.get("will-download")?.({}, item, guest);
    expect(items.filter((item) => (item.cancel as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toHaveLength(5);
  });

  it("saves a blob the page opens or navigates to", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const answer = guest.openHandler?.({ url: "blob:https://a.com/x", disposition: "foreground-tab", features: "" });
    expect(answer).toEqual({ action: "deny" });
    expect(guest.downloadURL).toHaveBeenCalledWith("blob:https://a.com/x");
    const event = { url: "blob:https://a.com/y", prevented: false, preventDefault() { this.prevented = true; } };
    guest.emit("will-navigate", event);
    expect(event.prevented).toBe(true);
    expect(guest.downloadURL).toHaveBeenCalledWith("blob:https://a.com/y");
  });
});

/** The prompts main sent the window, oldest first. */
const prompts = () =>
  host.sent.filter(([channel]) => channel === "browser:prompt").map(([, prompt]) => prompt as Record<string, unknown>);

async function answer(id: unknown, value: unknown) {
  const { answer: reply } = await import("./prompts");
  reply(host as never, id, value);
}

describe("permissions", () => {
  const request = (guest: FakeContents, permission: string, details: Record<string, unknown> = {}) =>
    new Promise<boolean>((resolve) =>
      electron.permissionRequest?.(guest, permission, resolve, {
        requestingUrl: "https://meet.example.com/room",
        isMainFrame: true,
        ...details,
      }),
    );

  it("grants what reaches no further than the page without asking", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(await request(guest, "fullscreen")).toBe(true);
    expect(await request(guest, "midi")).toBe(false);
    expect(prompts()).toEqual([]);
  });

  it("asks over the page, and remembers an answer the person asked to keep", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const first = request(guest, "media", { mediaTypes: ["video", "audio"] });
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    const [prompt] = prompts();
    expect(prompt).toMatchObject({
      kind: "permission",
      webContentsId: guest.id,
      origin: "https://meet.example.com",
      permissions: ["camera", "microphone"],
    });
    await answer(prompt?.id, { allow: true, remember: true });
    expect(await first).toBe(true);
    expect(await request(guest, "media", { mediaTypes: ["audio"] })).toBe(true);
    expect(prompts()).toHaveLength(1);
    expect(electron.permissionCheck?.(guest, "media", "https://meet.example.com", { mediaType: "video", isMainFrame: true })).toBe(true);
    expect(electron.permissionCheck?.(guest, "media", "https://other.com", { mediaType: "video", isMainFrame: true })).toBe(false);
  });

  it("asks again after a refusal that was not kept", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const first = request(guest, "notifications");
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    await answer(prompts()[0]?.id, { allow: false, remember: false });
    expect(await first).toBe(false);
    void request(guest, "notifications");
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
  });

  it("answers from what the window sent, and refuses a blocked site outright", async () => {
    guests.setSitePermissions({ "https://meet.example.com": { geolocation: "block", notifications: "allow" } });
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(await request(guest, "geolocation")).toBe(false);
    expect(await request(guest, "notifications")).toBe(true);
    expect(prompts()).toEqual([]);
  });

  it("drops a question when its page navigates away, answering no", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const pending = request(guest, "geolocation");
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://b.com/" });
    expect(await pending).toBe(false);
    expect(host.sent).toContainEqual(["browser:prompt-gone", prompts()[0]?.id]);
  });

  it("ignores an answer from a window that wasn't asked", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    let settled = false;
    void request(guest, "geolocation").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    const { answer: reply } = await import("./prompts");
    reply(new FakeContents() as never, prompts()[0]?.id, { allow: true, remember: true });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("keeps an incognito page's decisions out of the saved sessions", async () => {
    willAttach({ ...INCOGNITO, src: "https://a.com" });
    const incognito = didAttach();
    const first = request(incognito, "notifications");
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    await answer(prompts()[0]?.id, { allow: true, remember: true });
    expect(await first).toBe(true);
    willAttach({ ...PAGE, src: "https://a.com" });
    const saved = didAttach();
    void request(saved, "notifications");
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
  });

  it("tells the person when macOS keeps the camera from Crew", async () => {
    if (process.platform !== "darwin") return;
    electron.mediaStatus = "denied";
    guests.setSitePermissions({ "https://meet.example.com": { camera: "allow" } });
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(await request(guest, "media", { mediaTypes: ["video"] })).toBe(false);
    expect(prompts()[0]).toMatchObject({ kind: "system", permissions: ["camera"] });
  });
});

describe("another app's links", () => {
  const navigate = (contents: FakeContents, url: string) => {
    const event = { url, prevented: false, preventDefault() { this.prevented = true; } };
    contents.emit("will-navigate", event);
    return event.prevented;
  };

  it("opens the app only after the person says yes", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(navigate(guest, "zoommtg://zoom.us/join?confno=1")).toBe(true);
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toMatchObject({ kind: "external", app: "zoom.us", scheme: "zoommtg", origin: "https://a.com" });
    expect(electron.openExternal).not.toHaveBeenCalled();
    await answer(prompts()[0]?.id, { open: true });
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledWith("zoommtg://zoom.us/join?confno=1"));
  });

  it("drops a link no app handles, and never asks about Crew's own schemes", async () => {
    electron.appForProtocol.mockImplementation(() => "");
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    expect(navigate(guest, "nothing://x")).toBe(true);
    expect(navigate(guest, "crew-file://a/b")).toBe(true);
    await Promise.resolve();
    expect(prompts()).toEqual([]);
  });

  it("asks through the permission Chromium raises for a frame's link", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    const granted = new Promise<boolean>((resolve) =>
      electron.permissionRequest?.(guest, "openExternal", resolve, {
        requestingUrl: "https://a.com/",
        isMainFrame: false,
        externalURL: "slack://open",
      }),
    );
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    await answer(prompts()[0]?.id, { open: false });
    expect(await granted).toBe(false);
  });

  it("limits how often one page can ask", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    for (let i = 0; i < 10; i++) navigate(guest, "zoommtg://x");
    await vi.waitFor(() => expect(prompts()).toHaveLength(3));
  });
});

describe("site sign-in", () => {
  const login = (contents: FakeContents | null, isProxy = false) => {
    const callback = vi.fn();
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    electron.appHandlers.get("login")?.(
      event,
      contents,
      { url: "http://intranet.example.com/admin" },
      { isProxy, scheme: "basic", host: "intranet.example.com", port: 80, realm: "Admin" },
      callback,
    );
    return { callback, event };
  };

  it("asks for a page's basic auth over that page and answers with what was typed", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    (guest as unknown as { session: unknown }).session = sessionOf();
    const { callback, event } = login(guest);
    expect(event.prevented).toBe(true);
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toMatchObject({ kind: "auth", origin: "http://intranet.example.com", realm: "Admin", secure: false });
    await answer(prompts()[0]?.id, { username: "me", password: "pw" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith("me", "pw"));
  });

  it("cancels the sign-in when the person does", async () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    (guest as unknown as { session: unknown }).session = sessionOf();
    const { callback } = login(guest);
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    await answer(prompts()[0]?.id, null);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith());
  });

  it("leaves the app's own windows to Electron", () => {
    const { event } = login(new FakeContents());
    expect(event.prevented).toBe(false);
  });
});

/** The one fake session every partition shares; the page sessions are recognized by it. */
function sessionOf() {
  return electron.lastSession;
}

describe("hung pages", () => {
  it("tells the window a page stopped answering, and when it came back", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach();
    guest.emit("unresponsive");
    guest.emit("responsive");
    expect(host.sent.filter(([channel]) => channel === "browser:responsive")).toEqual([
      ["browser:responsive", { webContentsId: guest.id, hung: true }],
      ["browser:responsive", { webContentsId: guest.id, hung: false }],
    ]);
  });
});

describe("Google sign-in", () => {
  it("goes by Firefox's name on the sign-in page and by Chrome's elsewhere", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const guest = didAttach() as FakeContents & Record<string, unknown>;
    let agent = "Chrome";
    Object.assign(guest, {
      session: { getUserAgent: () => "Chrome" },
      getUserAgent: () => agent,
      setUserAgent: (next: string) => {
        agent = next;
      },
    });
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://accounts.google.com/signin" });
    expect(agent).toMatch(/Firefox/);
    guest.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false, url: "https://x.com/" });
    expect(agent).toMatch(/Firefox/);
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://mail.google.com/" });
    expect(agent).toBe("Chrome");
  });

  it("names Chrome in every page request's client hints", () => {
    willAttach({ ...PAGE, src: "https://a.com" });
    const callback = vi.fn();
    electron.headers?.({ url: "https://github.com/", requestHeaders: { "sec-ch-ua": '"Chromium";v="152"' } }, callback);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      requestHeaders: { "sec-ch-ua": expect.stringContaining('"Google Chrome"') },
    });
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
