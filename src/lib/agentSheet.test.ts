import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, agentNames, draftOf, nameError, shownError } from "./agentSheet";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./providers";
import type { Session } from "./types";

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    workspaceId: "w1",
    kind: "agent",
    name: "research",
    provider: "codex",
    model: "gpt-5.5",
    providerSessionId: null,
    description: "Reads papers",
    notifications: false,
    autonomy: "full",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe("draftOf", () => {
  it("starts a new agent empty, on the CLI's default provider and model", () => {
    expect(draftOf(null, {})).toEqual({
      name: "",
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      description: "",
      notifications: true,
      autonomy: "ask",
    });
  });

  it("lets the effective default agent choose a new agent's provider and model", () => {
    expect(draftOf(null, { provider: "cursor", model: "auto" })).toEqual({
      ...EMPTY_DRAFT,
      provider: "cursor",
      model: "auto",
    });
  });

  it("starts an edit from the session, ignoring the default", () => {
    expect(draftOf(session(), { provider: "cursor", model: "auto" })).toEqual({
      name: "research",
      provider: "codex",
      model: "gpt-5.5",
      description: "Reads papers",
      notifications: false,
      autonomy: "full",
    });
  });

  it("shows a session with no model as the CLI default", () => {
    expect(draftOf(session({ model: "" }), {}).model).toBe(DEFAULT_MODEL);
  });
});

describe("agentNames", () => {
  it("lists agents and leaves terminals out", () => {
    const sessions = [session({ name: "a" }), session({ name: "zsh", kind: "terminal" }), session({ name: "b" })];
    expect(agentNames(sessions)).toEqual(["a", "b"]);
  });
});

describe("nameError", () => {
  it("requires a name", () => {
    expect(nameError("", ["a"], undefined)).toEqual({ taken: false, error: "Name is required" });
  });

  it("refuses another agent's name, whatever its case", () => {
    expect(nameError("Research", ["research"], undefined)).toEqual({
      taken: true,
      error: "An agent with this name already exists",
    });
  });

  it("lets the agent being edited keep its own name", () => {
    expect(nameError("research", ["research"], "research")).toEqual({ taken: false, error: null });
  });

  it("refuses a different case of the edited agent's own name when another agent has it", () => {
    expect(nameError("RESEARCH", ["research", "Research"], "Research")).toEqual({
      taken: true,
      error: "An agent with this name already exists",
    });
  });

  it("accepts a free name", () => {
    expect(nameError("docs", ["research"], undefined)).toEqual({ taken: false, error: null });
  });
});

describe("shownError", () => {
  const taken = "An agent with this name already exists";

  it("shows a taken name as it is typed", () => {
    expect(shownError({ error: taken, taken: true, submitted: false, busy: false })).toBe(taken);
  });

  it("holds back a missing name until the first submit", () => {
    expect(shownError({ error: "Name is required", taken: false, submitted: false, busy: false })).toBeUndefined();
    expect(shownError({ error: "Name is required", taken: false, submitted: true, busy: false })).toBe("Name is required");
  });

  it("shows nothing while saving or closing", () => {
    expect(shownError({ error: taken, taken: true, submitted: true, busy: true })).toBeUndefined();
  });

  it("shows nothing once the name is fixed", () => {
    expect(shownError({ error: null, taken: false, submitted: true, busy: false })).toBeUndefined();
  });
});
