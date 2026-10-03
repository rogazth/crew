import { describe, expect, it } from "vitest";
import { osc777Message, oscClipboardText } from "./terminalClipboard";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("oscClipboardText", () => {
  it("decodes a write, whatever selection it names", () => {
    expect(oscClipboardText(`c;${b64("hello")}`)).toBe("hello");
    expect(oscClipboardText(`;${b64("tmux")}`)).toBe("tmux");
    expect(oscClipboardText(`pc;${b64("ñandú 🦤")}`)).toBe("ñandú 🦤");
  });

  it("clears the clipboard on an empty write", () => {
    expect(oscClipboardText("c;")).toBe("");
  });

  it("refuses a read and anything malformed", () => {
    expect(oscClipboardText("c;?")).toBeNull();
    expect(oscClipboardText("nope")).toBeNull();
    expect(oscClipboardText("c;%%%")).toBeNull();
  });
});

describe("osc777Message", () => {
  it("reads the body, and the title when there is none", () => {
    expect(osc777Message("notify;Codex;Turn complete")).toBe("Turn complete");
    expect(osc777Message("notify;Codex;a; b")).toBe("a; b");
    expect(osc777Message("notify;Codex;")).toBe("Codex");
    expect(osc777Message("notify")).toBeUndefined();
  });
});
