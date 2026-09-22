import { describe, expect, it } from "vitest";
import { PROVIDERS, parseAgentChoice, pickProvider } from "./providers";
import { sessionCommand } from "./sessionCommand";
import type { Session } from "./types";

const base: Session = {
  id: "crew-1",
  workspaceId: "w",
  kind: "terminal",
  name: "s",
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const argv = (patch: Partial<Session>, resume = false) =>
  sessionCommand({ ...base, ...patch }, { resume, theme: "dark" });

describe("sessionCommand", () => {
  it("leaves the model to Claude's own config when none is picked", () => {
    expect(argv({})).toEqual(["claude", "--settings", '{"theme":"dark"}', "--session-id", "crew-1"]);
    expect(argv({ model: "claude-opus-5-5" })).toContain("--model");
  });

  it("resumes Claude by Crew's own id", () => {
    expect(argv({}, true)).toEqual(["claude", "--settings", '{"theme":"dark"}', "--resume", "crew-1"]);
  });

  it("resumes the others by the id their CLI handed out", () => {
    expect(argv({ provider: "cursor", providerSessionId: "chat", model: "auto" })).toEqual([
      "cursor-agent",
      "--resume",
      "chat",
      "--model",
      "auto",
    ]);
    expect(argv({ provider: "codex", providerSessionId: "t1" })).toEqual(["codex", "resume", "t1"]);
    expect(argv({ provider: "opencode", providerSessionId: "ses_1", model: "opencode/x" })).toEqual([
      "opencode",
      "--session",
      "ses_1",
      "-m",
      "opencode/x",
    ]);
  });

  it("starts fresh until an id is known", () => {
    expect(argv({ provider: "codex", model: "gpt-6-astra" })).toEqual(["codex", "-m", "gpt-6-astra"]);
    expect(argv({ provider: "opencode" })).toEqual(["opencode"]);
  });
});

describe("pickProvider", () => {
  const only = (...ids: string[]) => PROVIDERS.filter((p) => ids.includes(p.id));

  it("keeps the preference while its CLI is installed", () => {
    const choice = { provider: "codex" as const, model: "gpt-5.5" };
    expect(pickProvider(choice, only("claude", "codex"))).toBe(choice);
  });

  it("falls back to the first installed provider on its default model", () => {
    expect(pickProvider({ provider: "codex", model: "gpt-5.5" }, only("opencode", "cursor"))).toEqual({
      provider: "cursor",
      model: "",
    });
  });
});

describe("parseAgentChoice", () => {
  it("rejects what is not a known provider", () => {
    expect(parseAgentChoice(null)).toBeNull();
    expect(parseAgentChoice('{"provider":"gemini"}')).toBeNull();
    expect(parseAgentChoice('{"provider":"codex"}')).toEqual({ provider: "codex", model: "" });
  });
});
