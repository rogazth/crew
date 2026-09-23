import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  PROVIDERS,
  modelLabel,
  modelsOf,
  parseAgentChoice,
  pickProvider,
  providerLine,
  providerOf,
} from "./providers";

describe("the registry", () => {
  it("resumes each CLI the way it expects", () => {
    expect(PROVIDERS.map((p) => [p.id, p.resumeArgs("abc")])).toEqual([
      ["claude", ["--resume", "abc"]],
      ["cursor", ["--resume", "abc"]],
      ["codex", ["resume", "abc"]],
      ["opencode", ["--session", "abc"]],
    ]);
  });

  it("knows no provider it does not list", () => {
    expect(providerOf("gemini")).toBeUndefined();
    expect(providerOf("codex")?.binary).toBe("codex");
  });
});

describe("modelsOf", () => {
  it("offers the CLI's own setting first, then the provider's models", () => {
    const models = modelsOf("codex");
    expect(models[0]).toEqual({ id: DEFAULT_MODEL, label: "Default", note: "The CLI's own setting" });
    expect(models.slice(1)).toEqual(providerOf("codex")?.models);
  });

  it("offers nothing for an unknown provider", () => {
    expect(modelsOf("gemini")).toEqual([]);
  });
});

describe("modelLabel", () => {
  it("names a known model and leaves an unknown one as its id", () => {
    expect(modelLabel("claude", "claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude", DEFAULT_MODEL)).toBe("Default");
    expect(modelLabel("claude", "claude-next")).toBe("claude-next");
    expect(modelLabel("gemini", "gemini-pro")).toBe("gemini-pro");
  });
});

describe("providerLine", () => {
  it("reads as the provider and then the model", () => {
    expect(providerLine("claude", "claude-opus-5")).toBe("Claude Opus 5");
    expect(providerLine("codex", "gpt-custom")).toBe("Codex gpt-custom");
  });

  it("is the provider alone when the CLI picks the model", () => {
    expect(providerLine("cursor", DEFAULT_MODEL)).toBe("Cursor");
  });

  it("shows an unknown provider by its id", () => {
    expect(providerLine("gemini", "")).toBe("gemini");
    expect(providerLine("gemini", "pro")).toBe("gemini pro");
  });
});

describe("pickProvider", () => {
  it("keeps the preference when no CLI is installed at all", () => {
    const choice = { provider: "claude" as const, model: "claude-opus-5" };
    expect(pickProvider(choice, [])).toBe(choice);
  });
});

describe("parseAgentChoice", () => {
  it("keeps the model that was saved with the provider", () => {
    expect(parseAgentChoice('{"provider":"claude","model":"claude-opus-5"}')).toEqual({
      provider: "claude",
      model: "claude-opus-5",
    });
  });

  it("falls back to the CLI's model when the saved one is not a string", () => {
    expect(parseAgentChoice('{"provider":"claude","model":5}')).toEqual({ provider: "claude", model: DEFAULT_MODEL });
  });

  it("rejects JSON that is not an object, and text that is not JSON", () => {
    expect(parseAgentChoice("null")).toBeNull();
    expect(parseAgentChoice("5")).toBeNull();
    expect(parseAgentChoice('"claude"')).toBeNull();
    expect(parseAgentChoice("{nope")).toBeNull();
    expect(parseAgentChoice('{"provider":5}')).toBeNull();
  });
});
