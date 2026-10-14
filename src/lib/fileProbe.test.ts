import { beforeEach, describe, expect, it, vi } from "vitest";

const asked: string[] = [];
const onDisk = new Set(["/w/b.png"]);
vi.mock("./api", () => ({
  pathIsFile: async (path: string) => {
    asked.push(path);
    return onDisk.has(path);
  },
}));

const { firstFile, firstKnown, isFile, resetFileProbe } = await import("./fileProbe");

describe("fileProbe", () => {
  beforeEach(() => {
    asked.length = 0;
    resetFileProbe();
  });

  it("asks once per path however many wait on it", async () => {
    const answers = await Promise.all([isFile("/w/b.png"), isFile("/w/b.png"), isFile("/w/b.png")]);
    expect(answers).toEqual([true, true, true]);
    expect(await isFile("/w/b.png")).toBe(true);
    expect(asked).toEqual(["/w/b.png"]);
  });

  it("finds the first candidate that is a file and remembers the misses", async () => {
    expect(await firstFile(["/w/a.png", "/w/b.png", "/w/c.png"])).toBe("/w/b.png");
    expect(asked).toEqual(["/w/a.png", "/w/b.png"]);
    expect(firstKnown(["/w/a.png", "/w/b.png"])).toBe("/w/b.png");
    expect(firstKnown(["/w/c.png"])).toBeUndefined();
    expect(await firstFile(["/w/a.png"])).toBeNull();
    expect(asked).toEqual(["/w/a.png", "/w/b.png"]);
  });

  it("asks a miss again once it is old", async () => {
    await isFile("/w/a.png");
    expect(firstKnown(["/w/a.png"])).toBeNull();
    expect(firstKnown(["/w/a.png"], Date.now() + 60_000)).toBeUndefined();
  });

  it("keeps at most four asks in flight", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/w/${i}.png`);
    expect((await Promise.all(paths.map((path) => isFile(path)))).every((found) => !found)).toBe(true);
    expect(asked.length).toBe(20);
  });
});
