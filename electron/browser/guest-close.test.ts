import { describe, expect, it } from "vitest";
import { ignoreWindowClose } from "./guest-close";

describe("ignoreWindowClose", () => {
  it("replaces close and does not let the page put it back", () => {
    const calls: string[] = [];
    const target = {
      close: () => {
        calls.push("real");
      },
    };
    ignoreWindowClose(target);
    target.close();
    expect(calls).toEqual([]);
    expect(() => {
      target.close = () => {
        calls.push("replaced");
      };
    }).toThrow(TypeError);
    target.close();
    expect(calls).toEqual([]);
  });

  it("assigns close when the property is already locked", () => {
    const target = {};
    Object.defineProperty(target, "close", {
      configurable: false,
      writable: true,
      value: () => {
        throw new Error("real");
      },
    });
    ignoreWindowClose(target as { close: () => void });
    expect(() => (target as { close: () => void }).close()).not.toThrow();
  });
});
