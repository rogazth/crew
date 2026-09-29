import { describe, expect, it } from "vitest";
import { parseSessionView, sessionSurface } from "./sessionView";

describe("parseSessionView", () => {
  it("reads what was saved and falls back to the terminal", () => {
    expect(parseSessionView("chat")).toBe("chat");
    expect(parseSessionView("terminal")).toBe("terminal");
    expect(parseSessionView(null)).toBe("terminal");
    expect(parseSessionView("agent")).toBe("terminal");
  });
});

describe("sessionSurface", () => {
  it("keeps an agent in its chat whatever the setting says", () => {
    expect(sessionSurface({ kind: "agent", provider: "claude" }, "terminal")).toBe("agent");
    expect(sessionSurface({ kind: "agent", provider: "cursor" }, "chat")).toBe("agent");
  });

  it("opens a session in the chat only when asked and its history can be read", () => {
    for (const provider of ["claude", "codex", "opencode"]) {
      expect(sessionSurface({ kind: "terminal", provider }, "chat")).toBe("chat");
      expect(sessionSurface({ kind: "terminal", provider }, "terminal")).toBe("terminal");
    }
  });

  it("keeps Cursor and unknown CLIs in the terminal", () => {
    expect(sessionSurface({ kind: "terminal", provider: "cursor" }, "chat")).toBe("terminal");
    expect(sessionSurface({ kind: "terminal", provider: "vim" }, "chat")).toBe("terminal");
  });
});
