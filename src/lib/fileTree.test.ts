import { describe, expect, it } from "vitest";
import { foldersTo, relativeTo, sameEntries, visibleRows } from "./fileTree";
import type { FolderEntry } from "./protocol";

const dir = (path: string): FolderEntry => ({ name: path.split("/").pop()!, path, dir: true, ignored: false });
const file = (path: string): FolderEntry => ({ name: path.split("/").pop()!, path, dir: false, ignored: false });

describe("visibleRows", () => {
  const children = new Map([
    ["/w", [dir("/w/src"), dir("/w/docs"), file("/w/README.md")]],
    ["/w/src", [dir("/w/src/lib"), file("/w/src/main.ts")]],
  ]);

  it("shows open folders' entries under them, a level deeper", () => {
    const rows = visibleRows("/w", children, new Set(["/w/src"]));
    expect(rows.map((row) => [row.entry.path, row.depth, row.expanded])).toEqual([
      ["/w/src", 0, true],
      ["/w/src/lib", 1, false],
      ["/w/src/main.ts", 1, false],
      ["/w/docs", 0, false],
      ["/w/README.md", 0, false],
    ]);
  });

  it("marks an open folder whose entries have not arrived", () => {
    const rows = visibleRows("/w", children, new Set(["/w/docs"]));
    expect(rows.find((row) => row.entry.path === "/w/docs")).toMatchObject({ expanded: true, loading: true });
  });

  it("keeps a folder's state while its parent is closed", () => {
    const rows = visibleRows("/w", children, new Set(["/w/src/lib"]));
    expect(rows.map((row) => row.entry.path)).toEqual(["/w/src", "/w/docs", "/w/README.md"]);
  });
});

describe("foldersTo", () => {
  it("lists the folders to open to show a file", () => {
    expect(foldersTo("/w", "/w/a/b/c.ts")).toEqual(["/w/a", "/w/a/b"]);
    expect(foldersTo("/w/", "/w/top.ts")).toEqual([]);
  });

  it("is empty outside the root", () => {
    expect(foldersTo("/w", "/elsewhere/a.ts")).toEqual([]);
    expect(foldersTo("/w", "/wx/a.ts")).toEqual([]);
  });
});

describe("relativeTo", () => {
  it("drops the root", () => {
    expect(relativeTo("/w", "/w/a/b.ts")).toBe("a/b.ts");
    expect(relativeTo("/w", "/other/b.ts")).toBe("/other/b.ts");
  });
});

describe("sameEntries", () => {
  it("compares what a row shows", () => {
    const list = [dir("/w/a"), file("/w/b")];
    expect(sameEntries(list, [dir("/w/a"), file("/w/b")])).toBe(true);
    expect(sameEntries(list, [dir("/w/a"), { ...file("/w/b"), ignored: true }])).toBe(false);
    expect(sameEntries(list, [dir("/w/a")])).toBe(false);
    expect(sameEntries(undefined, [])).toBe(false);
  });
});
