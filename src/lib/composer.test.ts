import { describe, expect, it } from "vitest";
import { canSend, composerKey, stepActive, submitAction } from "./composer";

const FILE = { name: "a.png", path: "/tmp/a.png" };
const key = (k: string, extra: { shiftKey?: boolean; isComposing?: boolean } = {}) => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  ...extra,
});

describe("canSend", () => {
  it("needs text or a file, a ready agent, and no turn running", () => {
    expect(canSend(true, "hi", [], false)).toBe(true);
    expect(canSend(true, "", [FILE], false)).toBe(true);
    expect(canSend(true, "  \n ", [], false)).toBe(false);
    expect(canSend(false, "hi", [], false)).toBe(false);
    expect(canSend(true, "hi", [], true)).toBe(false);
  });
});

describe("submitAction", () => {
  it("stops a running turn whether or not there is a draft", () => {
    expect(submitAction(true, false)).toBe("stop");
    expect(submitAction(true, true)).toBe("stop");
  });

  it("sends only what can be sent", () => {
    expect(submitAction(false, true)).toBe("send");
    expect(submitAction(false, false)).toBeNull();
  });
});

describe("composerKey", () => {
  it("submits on a bare Enter", () => {
    expect(composerKey(key("Enter"), false)).toEqual({ kind: "submit" });
  });

  it("leaves Shift+Enter to the textarea as a newline", () => {
    expect(composerKey(key("Enter", { shiftKey: true }), false)).toBeNull();
  });

  it("does not submit while an IME is composing", () => {
    expect(composerKey(key("Enter", { isComposing: true }), false)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(composerKey(key("a"), false)).toBeNull();
    expect(composerKey(key("ArrowDown"), false)).toBeNull();
    expect(composerKey(key("Escape"), false)).toBeNull();
  });

  it("gives the picker its arrows, Enter, Tab and Escape while it has results", () => {
    expect(composerKey(key("ArrowDown"), true)).toEqual({ kind: "move", step: 1 });
    expect(composerKey(key("ArrowUp"), true)).toEqual({ kind: "move", step: -1 });
    expect(composerKey(key("Enter"), true)).toEqual({ kind: "pick" });
    expect(composerKey(key("Enter", { shiftKey: true }), true)).toEqual({ kind: "pick" });
    expect(composerKey(key("Tab"), true)).toEqual({ kind: "pick" });
    expect(composerKey(key("Escape"), true)).toEqual({ kind: "dismiss" });
    expect(composerKey(key("x"), true)).toBeNull();
  });
});

describe("stepActive", () => {
  it("wraps at both ends", () => {
    expect(stepActive(0, 1, 3)).toBe(1);
    expect(stepActive(2, 1, 3)).toBe(0);
    expect(stepActive(0, -1, 3)).toBe(2);
  });
});
