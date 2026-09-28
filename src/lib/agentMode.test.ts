import { describe, expect, it } from "vitest";
import { agentKind, parseAgentMode } from "./agentMode";

describe("agentMode", () => {
  it("reads what was saved and falls back to the chat", () => {
    expect(parseAgentMode("cli")).toBe("cli");
    expect(parseAgentMode("chat")).toBe("chat");
    expect(parseAgentMode(null)).toBe("chat");
    expect(parseAgentMode("timeline")).toBe("chat");
  });

  it("makes a CLI agent a terminal session and a chat agent an agent", () => {
    expect(agentKind("cli")).toBe("terminal");
    expect(agentKind("chat")).toBe("agent");
  });
});
