import { describe, expect, it } from "vitest";
import {
  agentMentionAt,
  agentNote,
  agentRuns,
  completeAgentMention,
  mentionedAgents,
  searchAgents,
  splitAgentNote,
} from "./agentMentions";
import type { Session } from "./types";

const session = (id: string, name: string, kind: Session["kind"], updatedAt: number) =>
  ({ id, name, kind, provider: "claude", status: "idle", updatedAt }) as Session;

const AGENTS = [
  session("s-1", "Menciones de bots", "terminal", 3),
  session("s-2", "Menciones", "terminal", 1),
  session("b-1", "Lead", "bot", 2),
];

describe("agentMentionAt", () => {
  it("finds the hash that opens the word at the caret", () => {
    expect(agentMentionAt("ask #Le", 7)).toEqual({ start: 4, end: 7, query: "Le" });
    expect(agentMentionAt("#", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("ignores a hash glued to a word or a space typed since", () => {
    expect(agentMentionAt("C#", 2)).toBeNull();
    expect(agentMentionAt("#Lead done", 10)).toBeNull();
  });
});

describe("searchAgents", () => {
  it("lists the most recently active first, and matches names once typed", () => {
    expect(searchAgents("", AGENTS).map((a) => a.id)).toEqual(["s-1", "b-1", "s-2"]);
    expect(searchAgents("lead", AGENTS).map((a) => a.id)).toEqual(["b-1"]);
  });
});

describe("completeAgentMention", () => {
  it("puts the whole name in, spaces and all, and the caret after it", () => {
    expect(completeAgentMention("ask #me now", 7, AGENTS[0]!)).toEqual({ text: "ask #Menciones de bots  now", cursor: 23 });
  });
});

describe("agentRuns", () => {
  it("takes the longest name that ends where a word does", () => {
    const runs = agentRuns("#Menciones de bots y #Menciones. #Leader", AGENTS);
    expect(runs.map((run) => run.agent.id)).toEqual(["s-1", "s-2"]);
    expect(runs[0]).toMatchObject({ from: 0, to: 18 });
  });
});

describe("mentionedAgents", () => {
  it("names each agent once, in order", () => {
    expect(mentionedAgents("#Lead then #Menciones de bots and #Lead", AGENTS).map((a) => a.id)).toEqual(["b-1", "s-1"]);
  });
});

describe("agent notes", () => {
  it("round-trips: the note goes under the text and comes off again", () => {
    const text = `#Lead sigue con esto${agentNote([AGENTS[2]!, AGENTS[0]!])}`;
    expect(text).toContain("- #Lead: bot b-1 (claude, idle)");
    expect(text).toContain("- #Menciones de bots: session s-1 (claude, idle)");
    expect(splitAgentNote(text)).toEqual({
      body: "#Lead sigue con esto",
      agents: [
        { name: "Lead", kind: "bot", id: "b-1", provider: "claude" },
        { name: "Menciones de bots", kind: "session", id: "s-1", provider: "claude" },
      ],
    });
  });

  it("leaves a message with no note as it is", () => {
    expect(agentNote([])).toBe("");
    expect(splitAgentNote("hola")).toEqual({ body: "hola", agents: [] });
  });
});
