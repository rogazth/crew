// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  return import("./host");
}

function fakeHost() {
  return {
    daemonInfo: vi.fn(async () => ({ url: "ws://127.0.0.1:4100", token: "secret" })),
    open: vi.fn(async (): Promise<string | string[] | null> => "/picked"),
    homeDir: vi.fn(async () => "/home/me"),
    openUrl: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    pathForFile: vi.fn((file: File) => `/abs/${file.name}`),
  };
}

/** A File as a browser hands it over: `webkitRelativePath` is always a string, `path` only under old Electron. */
function file(name: string, { path, relative = "" }: { path?: string; relative?: string } = {}): File {
  const made = new File(["x"], name);
  Object.defineProperty(made, "webkitRelativePath", { value: relative });
  if (path !== undefined) Object.defineProperty(made, "path", { value: path });
  return made;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.crewHost;
});

describe("with the Electron host", () => {
  it("delegates every call to window.crewHost", async () => {
    const host = fakeHost();
    window.crewHost = host;
    const api = await load();
    const picked = file("a.txt");

    await expect(api.daemonInfo()).resolves.toEqual({ url: "ws://127.0.0.1:4100", token: "secret" });
    await expect(api.open({ directory: true })).resolves.toBe("/picked");
    await expect(api.homeDir()).resolves.toBe("/home/me");
    await api.openUrl("https://crew.dev/docs");
    await api.notify("Build done", "All green");
    expect(api.pathForFile(picked)).toBe("/abs/a.txt");

    expect(host.open).toHaveBeenCalledWith({ directory: true });
    expect(host.openUrl).toHaveBeenCalledWith("https://crew.dev/docs");
    expect(host.notify).toHaveBeenCalledWith("Build done", "All green");
    expect(host.pathForFile).toHaveBeenCalledWith(picked);
  });

  it.each(["http://localhost:3000/", "https://crew.dev/a?b=c", "mailto:me@crew.dev"])(
    "opens %s",
    async (url) => {
      const host = fakeHost();
      window.crewHost = host;
      await (await load()).openUrl(url);
      expect(host.openUrl).toHaveBeenCalledWith(url);
    },
  );

  it.each(["javascript:alert(1)", "file:///etc/passwd", "crew://session/1", "not a url", ""])(
    "refuses to open %j",
    async (url) => {
      const host = fakeHost();
      window.crewHost = host;
      await (await load()).openUrl(url);
      expect(host.openUrl).not.toHaveBeenCalled();
    },
  );
});

describe("in a browser without the host", () => {
  it("has no daemon to offer", async () => {
    await expect((await load()).daemonInfo()).rejects.toThrow("Crew daemon is not available");
  });

  it("has no home directory", async () => {
    await expect((await load()).homeDir()).resolves.toBe("");
  });

  it("opens allowed URLs in a new tab with no opener, and nothing else", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const api = await load();
    await api.openUrl("https://crew.dev");
    await api.openUrl("javascript:alert(1)");
    await api.openUrl("::");
    expect(opened.mock.calls).toEqual([["https://crew.dev", "_blank", "noopener,noreferrer"]]);
  });

  it("reads a file's path only when the runtime gave it one", async () => {
    const api = await load();
    expect(api.pathForFile(file("a.txt", { path: "/abs/a.txt" }))).toBe("/abs/a.txt");
    expect(api.pathForFile(file("b.txt"))).toBe("");
  });
});

describe("outside a browser", () => {
  it("has no daemon, home directory or host path", async () => {
    vi.stubGlobal("window", undefined);
    const api = await load();
    await expect(api.daemonInfo()).rejects.toThrow("Crew daemon is not available");
    await expect(api.homeDir()).resolves.toBe("");
    expect(api.pathForFile(file("a.txt", { path: "/abs/a.txt" }))).toBe("/abs/a.txt");
  });
});

describe("browser notifications", () => {
  function notifications(permission: NotificationPermission, answer: () => Promise<NotificationPermission>) {
    const shown: Array<{ title: string; body: string | undefined }> = [];
    const requestPermission = vi.fn(answer);
    class FakeNotification {
      static permission = permission;
      static requestPermission = requestPermission;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    return { shown, requestPermission };
  }

  it("does nothing where the Notification API is missing", async () => {
    vi.stubGlobal("Notification", undefined);
    await expect((await load()).notify("Done", "ok")).resolves.toBeUndefined();
  });

  it("shows straight away once permission is granted", async () => {
    const { shown, requestPermission } = notifications("granted", async () => "granted");
    await (await load()).notify("Done", "All green");
    expect(shown).toEqual([{ title: "Done", body: "All green" }]);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("stays quiet and never asks once permission is denied", async () => {
    const { shown, requestPermission } = notifications("denied", async () => "granted");
    await (await load()).notify("Done", "ok");
    expect(shown).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("asks once, then shows every notification after a yes", async () => {
    const { shown, requestPermission } = notifications("default", async () => "granted");
    const api = await load();
    await api.notify("One", "1");
    await api.notify("Two", "2");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(shown.map((n) => n.title)).toEqual(["One", "Two"]);
  });

  it("asks once and stays quiet after a no", async () => {
    const { shown, requestPermission } = notifications("default", async () => "denied");
    const api = await load();
    await api.notify("One", "1");
    await api.notify("Two", "2");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([]);
  });

  it("treats a failed permission prompt as a no", async () => {
    const { shown } = notifications("default", () => Promise.reject(new Error("blocked")));
    await (await load()).notify("One", "1");
    expect(shown).toEqual([]);
  });
});

describe("browser file picker", () => {
  /** Stubs the native dialog: the next file input the page clicks reports `outcome`. */
  function picker(outcome: File[] | "cancel") {
    const inputs: HTMLInputElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag);
      if (element instanceof HTMLInputElement) {
        inputs.push(element);
        element.click = () => {
          if (outcome === "cancel") {
            element.dispatchEvent(new Event("cancel"));
            return;
          }
          Object.defineProperty(element, "files", { value: outcome });
          element.dispatchEvent(new Event("change"));
        };
      }
      return element;
    }) as typeof document.createElement);
    return inputs;
  }

  it("resolves one pick to its path, else its relative path, else its name", async () => {
    const api = await load();
    picker([file("a.txt", { path: "/abs/a.txt" })]);
    await expect(api.open({})).resolves.toBe("/abs/a.txt");
    vi.restoreAllMocks();
    picker([file("b.txt", { relative: "docs/b.txt" })]);
    await expect(api.open({})).resolves.toBe("docs/b.txt");
    vi.restoreAllMocks();
    picker([file("c.txt")]);
    await expect(api.open({})).resolves.toBe("c.txt");
  });

  it("resolves a multi-select to every path in order", async () => {
    const api = await load();
    const inputs = picker([file("a.txt", { path: "/abs/a.txt" }), file("b.txt", { path: "/abs/b.txt" })]);
    await expect(api.open({ multiple: true })).resolves.toEqual(["/abs/a.txt", "/abs/b.txt"]);
    expect(inputs[0]?.multiple).toBe(true);
  });

  it("resolves null when the dialog is cancelled or nothing was chosen", async () => {
    const api = await load();
    picker("cancel");
    await expect(api.open({})).resolves.toBeNull();
    vi.restoreAllMocks();
    picker([]);
    await expect(api.open({ multiple: true })).resolves.toBeNull();
  });

  it("asks the dialog for a folder when picking a directory", async () => {
    const api = await load();
    const inputs = picker([file("a.ts", { relative: "proj/a.ts" })]);
    await api.open({ directory: true });
    expect(inputs[0]?.hasAttribute("webkitdirectory")).toBe(true);
  });

  it.each([
    ["an absolute path", { path: "/home/me/proj/src/a.ts", relative: "proj/src/a.ts" }, "/home/me/proj"],
    ["a path the relative path doesn't match", { path: "/elsewhere/a.ts", relative: "proj/a.ts" }, "/elsewhere"],
    ["only a path", { path: "/home/me/proj/a.ts" }, "/home/me/proj"],
    ["only a path at the root", { path: "/a.ts" }, "/a.ts"],
    ["only a relative path", { relative: "proj/src/a.ts" }, "proj"],
    ["neither", {}, "a.ts"],
  ])("resolves a directory pick with %s to its folder", async (_, where, folder) => {
    const api = await load();
    picker([file("a.ts", where), file("b.ts", where)]);
    await expect(api.open({ directory: true })).resolves.toBe(folder);
  });

  it("lists every file inside for a multi-select directory pick", async () => {
    const api = await load();
    picker([file("a.ts", { relative: "proj/a.ts" }), file("b.ts", { relative: "proj/src/b.ts" })]);
    await expect(api.open({ directory: true, multiple: true })).resolves.toEqual(["proj/a.ts", "proj/src/b.ts"]);
  });
});

describe("drag and drop", () => {
  type Drag = { types?: string[]; files?: File[]; x?: number; y?: number; relatedTarget?: EventTarget };

  function drag(type: string, init: Drag = {}): Event {
    const event = new Event(type, { cancelable: true });
    const dataTransfer = init.types ? { types: init.types, files: init.files ?? [] } : null;
    Object.defineProperties(event, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: init.x ?? 0 },
      clientY: { value: init.y ?? 0 },
      relatedTarget: { value: init.relatedTarget ?? null },
    });
    window.dispatchEvent(event);
    return event;
  }

  async function listen() {
    const handler = vi.fn();
    (await load()).onDragDrop(handler);
    return handler;
  }

  it("reports a file drag moving over the window in device pixels", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      const handler = await listen();
      const event = drag("dragover", { types: ["Files"], x: 10, y: 20 });
      expect(event.defaultPrevented).toBe(true);
      expect(handler).toHaveBeenCalledWith({ type: "over", position: { x: 20, y: 40 } });
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    }
  });

  it("treats a missing pixel ratio as 1", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 0, configurable: true });
    try {
      const handler = await listen();
      drag("dragover", { types: ["Files"], x: 10, y: 20 });
      expect(handler).toHaveBeenCalledWith({ type: "over", position: { x: 10, y: 20 } });
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    }
  });

  it("ignores drags that carry no files", async () => {
    const handler = await listen();
    const text = drag("dragover", { types: ["text/plain"] });
    const bare = drag("drop");
    expect(text.defaultPrevented).toBe(false);
    expect(bare.defaultPrevented).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports leaving the window, but not moving between elements inside it", async () => {
    const handler = await listen();
    drag("dragleave", { relatedTarget: document.body });
    expect(handler).not.toHaveBeenCalled();
    drag("dragleave");
    expect(handler).toHaveBeenCalledWith({ type: "leave" });
  });

  it("drops the paths it can resolve and logs the ones it can't", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = fakeHost();
    host.pathForFile.mockImplementation((dropped: File) => {
      if (dropped.name === "boom.txt") throw new Error("not a real file");
      return dropped.name === "" || dropped.name === "blob.txt" ? "" : `/abs/${dropped.name}`;
    });
    window.crewHost = host;
    const handler = await listen();

    const event = drag("drop", {
      types: ["Files"],
      files: [file("a.txt"), file("blob.txt"), file(""), file("boom.txt"), file("b.txt")],
      x: 5,
      y: 6,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      type: "drop",
      position: { x: 5, y: 6 },
      paths: ["/abs/a.txt", "/abs/b.txt"],
    });
    expect(error).toHaveBeenCalledWith("Drop rejected: no filesystem path for blob.txt");
    expect(error).toHaveBeenCalledWith("Drop rejected: no filesystem path for file");
    expect(error).toHaveBeenCalledWith("Drop rejected:", "not a real file");
  });

  it("logs a non-Error thrown while resolving a dropped file", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = fakeHost();
    host.pathForFile.mockImplementation(() => {
      throw "denied";
    });
    window.crewHost = host;
    const handler = await listen();
    drag("drop", { types: ["Files"], files: [file("a.txt")] });
    expect(handler).toHaveBeenCalledWith({ type: "drop", position: { x: 0, y: 0 }, paths: [] });
    expect(error).toHaveBeenCalledWith("Drop rejected:", "denied");
  });
});
