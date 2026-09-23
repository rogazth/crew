import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_THEME, parseAgentTheme } from "./agentTheme";

describe("parseAgentTheme", () => {
  it("keeps a known theme", () => {
    expect(parseAgentTheme("timeline")).toBe("timeline");
    expect(parseAgentTheme("default")).toBe("default");
  });

  it("falls back to the default for nothing stored or an unknown value", () => {
    expect(parseAgentTheme(null)).toBe(DEFAULT_AGENT_THEME);
    expect(parseAgentTheme("")).toBe("default");
    expect(parseAgentTheme("Timeline")).toBe("default");
    expect(parseAgentTheme('"timeline"')).toBe("default");
  });
});
