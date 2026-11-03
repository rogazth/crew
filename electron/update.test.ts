import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lines, named } from "./trace-recorder";

vi.mock("./trace", async () => (await import("./trace-recorder")).mockedTrace());
vi.mock("./build-info", () => ({ release: true, sha: "test" }));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    getPath: () => "/Applications/Crew.app/Contents/MacOS/Crew",
    quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

const { checkForUpdates } = await import("./update");

describe("update trace", () => {
  beforeEach(() => {
    lines.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a quiet check that could not reach the release is update.check_failed, with one line of why and no address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await checkForUpdates();

    const [failed] = named("update.check_failed");
    expect(failed?.level).toBe("WARN");
    expect(String(failed?.fields.error)).toContain("503");
    expect(JSON.stringify(lines)).not.toMatch(/https?:\/\//);
  });

  it("a check the user asked for shows its error and does not write the quiet line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));

    await checkForUpdates(true);

    expect(named("update.check_failed")).toEqual([]);
    expect(named("update.phase").at(-1)?.fields).toMatchObject({ to: "error" });
    expect(JSON.stringify(lines)).not.toMatch(/https?:\/\//);
  });
});
