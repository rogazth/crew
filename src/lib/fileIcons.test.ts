import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_ICON, DEFAULT_FOLDER_ICON } from "./fileIconManifest";
import { fileIconId, folderIconId } from "./fileIcons";

describe("fileIconId", () => {
  it.each([
    ["package.json", "fi-node"],
    [".gitignore", "fi-git"],
    ["Dockerfile", "fi-docker"],
    [".env.local", "fi-gear"],
    ["foo.d.ts", "fi-ts-types"],
    ["App.tsx", "fi-react-ts"],
    ["vite.config.ts", "fi-vite"],
    ["README.md", "fi-markdown"],
    ["src/components/App.TSX", "fi-react-ts"],
    ["code.typescript", "fi-ts"],
  ])("%s → %s", (name, id) => {
    expect(fileIconId(name)).toBe(id);
  });

  it("falls back to the generic file", () => {
    expect(fileIconId("unknown.xyz")).toBe(DEFAULT_FILE_ICON);
    expect(fileIconId("constructor")).toBe(DEFAULT_FILE_ICON);
    expect(fileIconId("")).toBe(DEFAULT_FILE_ICON);
  });
});

describe("folderIconId", () => {
  it.each([
    ["src", "fid-folder-orange-code"],
    [".github", "fid-folder-github"],
    ["node_modules", "fid-folder-node-modules"],
    ["/w/app/SRC/", "fid-folder-orange-code"],
  ])("%s → %s", (name, id) => {
    expect(folderIconId(name)).toBe(id);
  });

  it("falls back to the generic folder", () => {
    expect(folderIconId("whatever")).toBe(DEFAULT_FOLDER_ICON);
  });
});
