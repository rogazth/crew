import { describe, expect, it } from "vitest";
import { parseSessionView, sessionSurface } from "./sessionView";

describe("parseSessionView", () => {
  it("reads what was saved and falls back to the terminal", () => {
    expect(parseSessionView("chat")).toBe("chat");
    expect(parseSessionView("terminal")).toBe("terminal");
    expect(parseSessionView(null)).toBe("terminal");
    expect(parseSessionView("bot")).toBe("terminal");
  });
});

describe("sessionSurface", () => {
  it("keeps a bot in its chat whatever the setting says", () => {
    expect(sessionSurface({ kind: "bot", provider: "claude" }, "terminal")).toBe("turns");
    expect(sessionSurface({ kind: "bot", provider: "cursor" }, "chat")).toBe("turns");
  });

  it("shows a child in Crew's chat, which is what drives it", () => {
    for (const provider of ["claude", "codex", "opencode", "cursor"]) {
      expect(sessionSurface({ kind: "child", provider }, "terminal")).toBe("turns");
    }
  });

  it("opens a session in the chat only when asked and its history can be read", () => {
    for (const provider of ["claude", "codex", "opencode", "cursor"]) {
      expect(sessionSurface({ kind: "terminal", provider }, "chat")).toBe("chat");
      expect(sessionSurface({ kind: "terminal", provider }, "terminal")).toBe("terminal");
    }
  });

  it("keeps unknown CLIs in the terminal", () => {
    expect(sessionSurface({ kind: "terminal", provider: "vim" }, "chat")).toBe("terminal");
  });
});
