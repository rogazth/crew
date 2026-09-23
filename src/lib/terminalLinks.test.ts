import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so every fresh copy of the module under test (vi.resetModules) talks to this one fake.
const { fake } = await vi.hoisted(() => import("../test/fakeClient"));
vi.mock("./client", () => ({ client: fake.client }));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const click = {} as MouseEvent;

function terminal(lines: string[]): Terminal {
  const getLine = (index: number) => {
    const text = lines[index];
    return text === undefined ? undefined : { translateToString: () => text };
  };
  return { buffer: { active: { getLine } } } as unknown as Terminal;
}

function links(provider: ILinkProvider, lineNumber: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => provider.provideLinks(lineNumber, resolve));
}

function existing(...paths: string[]) {
  const set = new Set(paths);
  fake.respond("path_exists", ({ path }) => set.has(path as string));
}

async function load() {
  return import("./terminalLinks");
}

beforeEach(() => {
  fake.reset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filePathProvider", () => {
  it("answers at once with nothing for a line without paths", async () => {
    const { filePathProvider } = await load();
    const callback = vi.fn();
    filePathProvider(terminal(["all tests passed"]), "/work", vi.fn()).provideLinks(1, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
    expect(fake.sent("path_exists")).toEqual([]);
  });

  it("answers with nothing for a line past the buffer", async () => {
    const { filePathProvider } = await load();
    const callback = vi.fn();
    filePathProvider(terminal([]), "/work", vi.fn()).provideLinks(3, callback);
    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it("links only the paths that exist, on the hovered line", async () => {
    existing("/work/src/a.ts");
    const { filePathProvider } = await load();
    const provider = filePathProvider(terminal(["intro", "see src/a.ts and src/gone.ts"]), "/work", vi.fn());
    const found = await links(provider, 2);
    expect(fake.sent("path_exists")).toEqual([{ path: "/work/src/a.ts" }, { path: "/work/src/gone.ts" }]);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.text).toBe("src/a.ts");
    expect(found?.[0]?.range).toEqual({ start: { x: 5, y: 2 }, end: { x: 12, y: 2 } });
  });

  it("opens the resolved file, without its :line suffix, on activate", async () => {
    existing("/work/src/a.ts");
    const { filePathProvider } = await load();
    const open = vi.fn();
    const found = await links(filePathProvider(terminal(["src/a.ts:12:3"]), "/work", open), 1);
    expect(found?.[0]?.text).toBe("src/a.ts:12:3");
    found?.[0]?.activate(click, "src/a.ts:12:3");
    expect(open).toHaveBeenCalledWith("/work/src/a.ts");
  });

  it("answers with nothing when no path on the line exists", async () => {
    existing();
    const { filePathProvider } = await load();
    expect(await links(filePathProvider(terminal(["src/a.ts"]), "/work", vi.fn()), 1)).toBeUndefined();
  });

  it("treats a path the daemon cannot check as missing", async () => {
    fake.respond("path_exists", () => {
      throw new Error("daemon down");
    });
    const { filePathProvider } = await load();
    expect(await links(filePathProvider(terminal(["src/a.ts"]), "/work", vi.fn()), 1)).toBeUndefined();
  });

  it("remembers what it learned, found or not, so hovering again asks nothing", async () => {
    existing("/work/src/a.ts");
    const { filePathProvider } = await load();
    const provider = filePathProvider(terminal(["src/a.ts src/gone.ts"]), "/work", vi.fn());
    await links(provider, 1);
    const again = await links(provider, 1);
    expect(again).toHaveLength(1);
    expect(fake.sent("path_exists")).toHaveLength(2);
  });

  it("forgets everything once it has learned more than 500 paths", async () => {
    existing();
    const { filePathProvider } = await load();
    const many = Array.from({ length: 502 }, (_, i) => `d/${i}.ts`).join(" ");
    const provider = filePathProvider(terminal([many, "d/0.ts"]), "/work", vi.fn());
    await links(provider, 1);
    expect(fake.sent("path_exists")).toHaveLength(502);
    await links(provider, 2);
    expect(fake.sent("path_exists").at(-1)).toEqual({ path: "/work/d/0.ts" });
    expect(fake.sent("path_exists")).toHaveLength(503);
  });

  it("resolves ~/ paths against the home dir once the host has named it", async () => {
    vi.stubGlobal("window", { crewHost: { homeDir: () => Promise.resolve("/Users/me") } });
    existing("/Users/me/notes/todo.md");
    const { filePathProvider } = await load();
    await flush();
    const open = vi.fn();
    const found = await links(filePathProvider(terminal(["~/notes/todo.md"]), "/work", open), 1);
    found?.[0]?.activate(click, "~/notes/todo.md");
    expect(open).toHaveBeenCalledWith("/Users/me/notes/todo.md");
  });
});

it("re-exports openExternal for the terminal's URL links", async () => {
  const links = await load();
  const external = await import("./external");
  expect(links.openExternal).toBe(external.openExternal);
});
