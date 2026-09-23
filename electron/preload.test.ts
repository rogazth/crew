import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock("electron", () => electron);

type CrewHost = {
  daemonInfo(): Promise<unknown>;
  open(opts: { multiple?: boolean; directory?: boolean }): Promise<unknown>;
  homeDir(): Promise<unknown>;
  openUrl(url: string): Promise<unknown>;
  notify(title: string, body: string): Promise<unknown>;
  pathForFile(file: File): string;
};

async function expose(): Promise<CrewHost> {
  vi.resetModules();
  await import("./preload");
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [name, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, CrewHost];
  expect(name).toBe("crewHost");
  return api;
}

describe("preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.ipcRenderer.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => ({ channel, args }));
    electron.webUtils.getPathForFile.mockReturnValue("/Users/me/notes.md");
  });

  it("exposes exactly the crewHost methods to the renderer", async () => {
    const host = await expose();
    expect(Object.keys(host).sort()).toEqual(["daemonInfo", "homeDir", "notify", "open", "openUrl", "pathForFile"]);
  });

  it("asks main for the daemon info", async () => {
    const host = await expose();
    expect(await host.daemonInfo()).toEqual({ channel: "daemon-info", args: [] });
  });

  it("passes the open options through to the dialog handler", async () => {
    const host = await expose();
    expect(await host.open({ multiple: true })).toEqual({ channel: "dialog-open", args: [{ multiple: true }] });
    expect(await host.open({ directory: true })).toEqual({ channel: "dialog-open", args: [{ directory: true }] });
  });

  it("asks main for the home directory", async () => {
    const host = await expose();
    expect(await host.homeDir()).toEqual({ channel: "home-dir", args: [] });
  });

  it("sends the url to open as is", async () => {
    const host = await expose();
    expect(await host.openUrl("https://example.com/a?b=c")).toEqual({
      channel: "open-url",
      args: ["https://example.com/a?b=c"],
    });
  });

  it("packs a notification's title and body into one payload", async () => {
    const host = await expose();
    expect(await host.notify("Crew", "Session finished")).toEqual({
      channel: "notify",
      args: [{ title: "Crew", body: "Session finished" }],
    });
  });

  it("resolves a dropped file's path in the preload, without a round trip to main", async () => {
    const host = await expose();
    const file = { name: "notes.md" } as File;
    expect(host.pathForFile(file)).toBe("/Users/me/notes.md");
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledWith(file);
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});
