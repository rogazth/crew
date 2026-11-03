import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginLaunch } from "./launch-guard";

describe("the launch guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "crew-guard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts normally the first time and after a run that settled", () => {
    const first = beginLaunch(dir);
    expect(first.safeStart).toBe(false);
    first.settle();
    expect(beginLaunch(dir).safeStart).toBe(false);
  });

  it("starts safely after a run that died before settling, and keeps doing so until one settles", () => {
    expect(beginLaunch(dir).safeStart).toBe(false);
    expect(beginLaunch(dir).safeStart).toBe(true);
    const third = beginLaunch(dir);
    expect(third.safeStart).toBe(true);
    third.settle();
    expect(beginLaunch(dir).safeStart).toBe(false);
  });

  it("launches anyway when the marker can't be written", () => {
    const guard = beginLaunch(path.join(dir, "missing"));
    expect(guard.safeStart).toBe(false);
    expect(() => guard.settle()).not.toThrow();
  });
});
