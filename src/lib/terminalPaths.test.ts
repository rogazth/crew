import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findPaths, quotePath, quotePaths, resolvePath } from "./terminalPaths";

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quotePath", () => {
  it("leaves a path the shell reads verbatim unquoted", () => {
    expect(quotePath("/Users/me/code/crew/src/App.tsx")).toBe("/Users/me/code/crew/src/App.tsx");
    expect(quotePath("a+b=c,d@e%f:g_h-i.j")).toBe("a+b=c,d@e%f:g_h-i.j");
  });

  it("single-quotes anything the shell would re-read", () => {
    expect(quotePath("/tmp/my file.png")).toBe("'/tmp/my file.png'");
    expect(quotePath("/tmp/$HOME")).toBe("'/tmp/$HOME'");
    expect(quotePath("/tmp/a*b")).toBe("'/tmp/a*b'");
    expect(quotePath("~/notes")).toBe("'~/notes'");
  });

  it("escapes single quotes inside the path", () => {
    expect(quotePath("/tmp/it's here")).toBe("'/tmp/it'\\''s here'");
  });

  it("quotes an empty path so it stays one argument", () => {
    expect(quotePath("")).toBe("''");
  });

  it("joins several paths with spaces, each quoted on its own", () => {
    expect(quotePaths(["/a/b", "/c d/e"])).toBe("/a/b '/c d/e'");
    expect(quotePaths([])).toBe("");
  });
});

describe("findPaths", () => {
  it("finds a relative path and where it starts", () => {
    expect(findPaths("see src/lib/api.ts for details")).toEqual([
      { text: "src/lib/api.ts", start: 4, path: "src/lib/api.ts" },
    ]);
  });

  it("finds absolute, home, and dot-relative paths", () => {
    expect(findPaths("/etc/nginx/nginx.conf").map((hit) => hit.path)).toEqual(["/etc/nginx/nginx.conf"]);
    expect(findPaths("~/code/crew").map((hit) => hit.path)).toEqual(["~/code/crew"]);
    expect(findPaths("./src/main.tsx").map((hit) => hit.path)).toEqual(["./src/main.tsx"]);
    expect(findPaths("../shared/util.ts").map((hit) => hit.path)).toEqual(["../shared/util.ts"]);
  });

  it("underlines a :line and :line:col suffix but strips it from the path", () => {
    expect(findPaths("error in src/app.ts:12:5")).toEqual([
      { text: "src/app.ts:12:5", start: 9, path: "src/app.ts" },
    ]);
    expect(findPaths("src/app.ts:12")).toEqual([{ text: "src/app.ts:12", start: 0, path: "src/app.ts" }]);
  });

  it("drops trailing prose punctuation", () => {
    expect(findPaths("Edited src/app.ts.")[0]?.text).toBe("src/app.ts");
    expect(findPaths("Edited src/app.ts, then src/b.ts;")).toEqual([
      { text: "src/app.ts", start: 7, path: "src/app.ts" },
      { text: "src/b.ts", start: 24, path: "src/b.ts" },
    ]);
    expect(findPaths("(see src/app.ts:3).")[0]).toEqual({ text: "src/app.ts:3", start: 5, path: "src/app.ts" });
    expect(findPaths("at src/app.ts: done")[0]?.text).toBe("src/app.ts");
  });

  it("keeps dots inside the name", () => {
    expect(findPaths("vite.config.ts and .github/workflows/ci.yml")).toEqual([
      { text: ".github/workflows/ci.yml", start: 19, path: ".github/workflows/ci.yml" },
    ]);
  });

  it("stops at characters a path segment never contains", () => {
    expect(findPaths("`src/a.ts`")).toEqual([{ text: "src/a.ts", start: 1, path: "src/a.ts" }]);
    expect(findPaths('"src/a.ts"')[0]?.text).toBe("src/a.ts");
    expect(findPaths("[src/a.ts]")[0]?.text).toBe("src/a.ts");
  });

  it("finds nothing in a line without a slash-separated path", () => {
    expect(findPaths("README.md is fine")).toEqual([]);
    expect(findPaths("all tests passed")).toEqual([]);
    expect(findPaths("")).toEqual([]);
  });
});

describe("resolvePath", () => {
  it("keeps an absolute path as is", () => {
    expect(resolvePath("/etc/hosts", "/work", "/home/me")).toBe("/etc/hosts");
  });

  it("resolves ~/ against home", () => {
    expect(resolvePath("~/notes/todo.md", "/work", "/home/me")).toBe("/home/me/notes/todo.md");
    expect(resolvePath("~/notes", "/work", "/home/me/")).toBe("/home/me/notes");
  });

  it("resolves a relative path against the cwd", () => {
    expect(resolvePath("src/app.ts", "/work", "/home/me")).toBe("/work/src/app.ts");
    expect(resolvePath("./src/app.ts", "/work/", "/home/me")).toBe("/work/src/app.ts");
    expect(resolvePath("../up.ts", "/work", "/home/me")).toBe("/work/../up.ts");
  });

  it("leaves the path alone while its root is unknown", () => {
    expect(resolvePath("~/notes", "/work", "")).toBe("~/notes");
    expect(resolvePath("src/app.ts", "", "/home/me")).toBe("src/app.ts");
  });
});

describe("homePath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is empty until the host answers, then the home dir without its trailing slash", async () => {
    let answer!: (dir: string) => void;
    const homeDir = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    vi.stubGlobal("window", { crewHost: { homeDir } });
    const { homePath } = await import("./terminalPaths");
    expect(homePath()).toBe("");
    answer("/Users/me/");
    await vi.waitFor(() => expect(homePath()).toBe("/Users/me"));
    expect(homeDir).toHaveBeenCalledTimes(1);
  });

  it("stays empty when the host cannot tell", async () => {
    const homeDir = vi.fn(() => Promise.reject(new Error("gone")));
    vi.stubGlobal("window", { crewHost: { homeDir } });
    const { homePath } = await import("./terminalPaths");
    await flush();
    expect(homeDir).toHaveBeenCalled();
    expect(homePath()).toBe("");
  });

  it("stays empty outside the app shell", async () => {
    const { homePath } = await import("./terminalPaths");
    await flush();
    expect(homePath()).toBe("");
  });
});
