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
  it("keeps a bot in its chat whatever its row says", () => {
    expect(sessionSurface({ kind: "bot" })).toBe("turns");
    expect(sessionSurface({ kind: "bot", view: "terminal" })).toBe("turns");
  });

  it("shows a child in Crew's chat, which is what drives it", () => {
    expect(sessionSurface({ kind: "child" })).toBe("turns");
    expect(sessionSurface({ kind: "child", view: "terminal" })).toBe("turns");
  });

  it("opens a terminal session where its row says", () => {
    expect(sessionSurface({ kind: "terminal", view: "chat" })).toBe("turns");
    expect(sessionSurface({ kind: "terminal", view: "terminal" })).toBe("terminal");
  });

  it("reads a terminal session without a view as its terminal", () => {
    expect(sessionSurface({ kind: "terminal" })).toBe("terminal");
  });
});
