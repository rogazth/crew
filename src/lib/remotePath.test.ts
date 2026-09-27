import { describe, expect, it } from "vitest";
import { joinPath, leafOf, parentOf, prettyPath, resolveTyped, splitTyped } from "./remotePath";

const HOME = "/home/agent";

describe("remote paths", () => {
  it("reads what is typed as a folder and the start of a name in it", () => {
    expect(splitTyped("~/", HOME)).toEqual({ dir: HOME, filter: "" });
    expect(splitTyped("~/code/sto", HOME)).toEqual({ dir: `${HOME}/code`, filter: "sto" });
    expect(splitTyped("code/", HOME)).toEqual({ dir: `${HOME}/code`, filter: "" });
    expect(splitTyped("/srv/ap", HOME)).toEqual({ dir: "/srv", filter: "ap" });
    expect(splitTyped("~", HOME)).toEqual({ dir: HOME, filter: "" });
    expect(splitTyped("pro", HOME)).toEqual({ dir: HOME, filter: "pro" });
  });

  it("resolves home, relative names and dots", () => {
    expect(resolveTyped("~/a/../b/", HOME)).toBe(`${HOME}/b`);
    expect(resolveTyped("/", HOME)).toBe("/");
    expect(resolveTyped("//srv///app/", HOME)).toBe("/srv/app");
  });

  it("walks up, names the leaf, and joins", () => {
    expect(parentOf(`${HOME}/code`)).toBe(HOME);
    expect(parentOf("/srv")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(leafOf(`${HOME}/code/`)).toBe("code");
    expect(joinPath(HOME, "code")).toBe(`${HOME}/code`);
  });

  it("shows paths under home with a tilde", () => {
    expect(prettyPath(HOME, HOME)).toBe("~");
    expect(prettyPath(`${HOME}/code`, HOME)).toBe("~/code");
    expect(prettyPath("/home/agentx", HOME)).toBe("/home/agentx");
    expect(prettyPath("/srv", "/")).toBe("/srv");
  });
});
