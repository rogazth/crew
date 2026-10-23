import { mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_OPTIONS, controlPath, setControlDir } from "./ssh-options";

describe("ssh options", () => {
  // Connections nobody watches: never a prompt, never this Mac's agent or X11 handed over.
  it("hardens every connection", () => {
    expect(BASE_OPTIONS).toEqual(expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=accept-new", "ForwardAgent=no", "ForwardX11=no"]));
  });

  it("keeps one private socket per machine, and none until main names the folder", () => {
    expect(controlPath({ destination: "atlas" })).toBe("none");
    const dir = path.join(mkdtempSync("/tmp/crew-ssh-test-"), "ssh");
    setControlDir(dir);
    const atlas = controlPath({ destination: "atlas" });
    expect(path.dirname(atlas)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(controlPath({ destination: "atlas" })).toBe(atlas);
    expect(controlPath({ destination: "atlas", user: "deploy" })).not.toBe(atlas);
    expect(controlPath({ destination: "atlas", port: 2222 })).not.toBe(atlas);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("goes without one when the path would be too long for a socket", () => {
    setControlDir(path.join("/tmp", "x".repeat(120)));
    expect(controlPath({ destination: "atlas" })).toBe("none");
  });
});
