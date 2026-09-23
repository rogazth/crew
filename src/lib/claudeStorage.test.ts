import { describe, expect, it } from "vitest";
import { claudeSessionId, transcriptPath } from "./claudeStorage";
import type { Session } from "./types";

const session = (over: Partial<Session> = {}): Session => ({
  id: "crew-1",
  workspaceId: "w1",
  kind: "terminal",
  name: "claude",
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("claudeSessionId", () => {
  it("is Crew's own id until Claude moves to a session of its own", () => {
    expect(claudeSessionId(session())).toBe("crew-1");
  });

  it("follows the provider session once one is bound, as after /clear", () => {
    expect(claudeSessionId(session({ providerSessionId: "claude-7" }))).toBe("claude-7");
  });
});

describe("transcriptPath", () => {
  it("files the transcript under the project slug Claude derives from the cwd", () => {
    expect(transcriptPath("/Users/me", "/Users/me/code/crew", "abc")).toBe(
      "/Users/me/.claude/projects/-Users-me-code-crew/abc.jsonl",
    );
  });

  it("turns every character outside [A-Za-z0-9] into a dash", () => {
    expect(transcriptPath("/home/me", "/home/me/my app.v2_x", "id")).toBe(
      "/home/me/.claude/projects/-home-me-my-app-v2-x/id.jsonl",
    );
  });

  it("ignores a trailing slash on home", () => {
    expect(transcriptPath("/home/me/", "/w", "id")).toBe("/home/me/.claude/projects/-w/id.jsonl");
  });
});
