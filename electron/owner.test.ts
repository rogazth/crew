import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { watchOwner } from "./owner";

describe("watching the process an app is to outlive no longer", () => {
  it("calls back once it exits, and not before", async () => {
    const owner = spawn("sleep", ["0.3"]);
    let called = false;
    const gone = new Promise<void>((resolve) =>
      watchOwner(owner.pid!, () => {
        called = true;
        resolve();
      }, 20),
    );
    expect(called).toBe(false);
    await gone;
    expect(owner.exitCode ?? owner.signalCode).not.toBeNull();
  });
});
