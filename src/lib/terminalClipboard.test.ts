import { describe, expect, it } from "vitest";
import { oscClipboardText } from "./terminalClipboard";

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
