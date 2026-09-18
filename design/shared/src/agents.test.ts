import { describe, expect, it } from "vitest";
import {
  attribution,
  conversationBetween,
  conversations,
  flattenLineage,
  graph,
  letters,
  lineage,
  mailbox,
  rosterFrom,
} from "./agents";
import type { Block, Session } from "./types";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function agent(id: string, name: string, createdBy?: { id: string; name: string }): Session {
  return {
    id,
    workspaceId: "ws",
    kind: "agent",
    name,
    provider: "claude",
    model: "claude-opus-5",
    providerSessionId: null,
    description: "",
    notifications: true,
    autonomy: "ask",
    status: "idle",
    createdAt: NOW - 1000,
    updatedAt: NOW,
    ...(createdBy ? { createdBy } : {}),
  };
}

const sent = (id: string, to: string, text: string, at: number): Block => ({
  id,
  role: "tool",
  text: "Message",
  at,
  tool: {
    callId: id,
    name: "message_agent",
    title: "Message",
    status: "completed",
    detail: { kind: "message", to, text },
  },
});

const got = (id: string, from: { id: string; name: string }, text: string, at: number): Block => ({
  id,
  role: "user",
  text,
  at,
  fromAgent: from,
});

const A = agent("a", "Alpha");
const B = agent("b", "Beta");
const C = agent("c", "Gamma");

describe("letters — a message exists twice and must be counted once", () => {
  it("pairs an outbound call with the inbound turn it became", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "please review the seam", NOW)],
      b: [got("r1", { id: "a", name: "Alpha" }, "please review the seam", NOW + 30 * MIN)],
    });
    const all = letters(roster);
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("delivered");
    expect(all[0]!.sentBlockId).toBe("s1");
    expect(all[0]!.receivedBlockId).toBe("r1");
  });

  it("pairs through the envelope header the daemon wraps a letter in", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "please review the seam", NOW)],
      b: [
        got(
          "r1",
          { id: "a", name: "Alpha" },
          "## Message\nFrom: Alpha (agent a)\nAt: 2026-09-18\n\nplease review the seam",
          NOW + MIN,
        ),
      ],
    });
    expect(letters(roster)[0]!.state).toBe("delivered");
  });

  it("calls an unmatched outbound letter waiting", () => {
    const roster = rosterFrom([A, B], { a: [sent("s1", "b", "still queued", NOW)], b: [] });
    const all = letters(roster);
    expect(all[0]!.state).toBe("waiting");
    expect(all[0]!.receivedBlockId).toBeUndefined();
  });

  it("refuses to pair a delivery that predates its send", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "hello there", NOW)],
      b: [got("r1", { id: "a", name: "Alpha" }, "hello there", NOW - 2 * 60 * MIN)],
    });
    // Two halves, neither a pair: one waiting outbound and one orphan inbound.
    const all = letters(roster);
    expect(all).toHaveLength(2);
    expect(all.filter((l) => l.state === "waiting")).toHaveLength(1);
  });

  it("gives two identical letters one delivery each, oldest first", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "ping", NOW), sent("s2", "b", "ping", NOW + 5 * MIN)],
      b: [
        got("r1", { id: "a", name: "Alpha" }, "ping", NOW + MIN),
        got("r2", { id: "a", name: "Alpha" }, "ping", NOW + 6 * MIN),
      ],
    });
    const all = letters(roster);
    expect(all).toHaveLength(2);
    expect(all.every((l) => l.state === "delivered")).toBe(true);
    expect(all.find((l) => l.sentBlockId === "s1")!.receivedBlockId).toBe("r1");
    expect(all.find((l) => l.sentBlockId === "s2")!.receivedBlockId).toBe("r2");
  });

  it("keeps an inbound whose sender's transcript we do not hold", () => {
    const roster = rosterFrom([A, B], {
      b: [got("r1", { id: "gone", name: "Deleted" }, "from beyond", NOW)],
    });
    const all = letters(roster);
    expect(all).toHaveLength(1);
    expect(all[0]!.from.name).toBe("Deleted");
    expect(all[0]!.state).toBe("delivered");
  });

  it("recovers a letter the adapter dropped, from the gateway's own result", () => {
    const blob: Block = {
      id: "s1",
      role: "tool",
      text: "Crew call tool message_agent",
      at: NOW,
      tool: {
        callId: "c",
        name: "crew_call_tool",
        title: "Crew call tool message_agent",
        status: "completed",
        detail: {
          kind: "output",
          text: JSON.stringify({ delivered: true, to: "Beta", waiting: 0 }),
        },
      },
    };
    const roster = rosterFrom([A, B], { a: [blob], b: [] });
    const all = letters(roster);
    expect(all).toHaveLength(1);
    // The result names the target; the roster turns that name back into an id.
    expect(all[0]!.to.id).toBe("b");
  });
});

describe("conversations", () => {
  it("orients a pair the same way whichever side you come from", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "one", NOW)],
      b: [sent("s2", "a", "two", NOW + MIN)],
    });
    const found = conversations(roster);
    expect(found).toHaveLength(1);
    expect(found[0]!.letters).toHaveLength(2);
    expect(conversationBetween(roster, "a", "b")).toEqual(conversationBetween(roster, "b", "a"));
  });

  it("counts what is still waiting per conversation", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "queued one", NOW), sent("s2", "b", "queued two", NOW + MIN)],
      b: [],
    });
    expect(conversationBetween(roster, "a", "b")!.waiting).toBe(2);
  });

  it("returns null for two agents that never wrote", () => {
    const roster = rosterFrom([A, B, C], { a: [], b: [], c: [] });
    expect(conversationBetween(roster, "a", "c")).toBeNull();
  });
});

describe("mailbox", () => {
  it("lists what is queued for one agent, oldest first", () => {
    const roster = rosterFrom([A, B, C], {
      a: [sent("s1", "b", "second", NOW + MIN), sent("s2", "b", "first", NOW)],
      c: [sent("s3", "b", "third", NOW + 2 * MIN)],
      b: [],
    });
    const box = mailbox(roster, "b");
    expect(box.map((l) => l.text)).toEqual(["first", "second", "third"]);
  });

  it("is empty once everything has been delivered", () => {
    const roster = rosterFrom([A, B], {
      a: [sent("s1", "b", "done deal", NOW)],
      b: [got("r1", { id: "a", name: "Alpha" }, "done deal", NOW + MIN)],
    });
    expect(mailbox(roster, "b")).toHaveLength(0);
  });
});

describe("graph", () => {
  it("counts per node and per direction", () => {
    const roster = rosterFrom([A, B, C], {
      a: [sent("s1", "b", "x", NOW), sent("s2", "c", "y", NOW + MIN)],
      b: [got("r1", { id: "a", name: "Alpha" }, "x", NOW + MIN)],
      c: [],
    });
    const g = graph(roster);
    const alpha = g.nodes.find((n) => n.agent.id === "a")!;
    expect(alpha.sent).toBe(2);
    expect(g.edges.find((e) => e.from.id === "a" && e.to.id === "c")!.waiting).toBe(1);
  });

  it("lists every agent, including ones nobody has written to", () => {
    const g = graph(rosterFrom([A, B, C], {}));
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(0);
  });
});

describe("lineage", () => {
  const root = agent("root", "Root");
  const child = agent("child", "Child", { id: "root", name: "Root" });
  const grand = agent("grand", "Grand", { id: "child", name: "Child" });

  it("builds the creation tree and reports depth", () => {
    const flat = flattenLineage(lineage([root, child, grand]));
    expect(flat.map((n) => [n.session.name, n.depth])).toEqual([
      ["Root", 0],
      ["Child", 1],
      ["Grand", 2],
    ]);
  });

  it("treats an agent whose parent is gone as a root", () => {
    const orphan = agent("orphan", "Orphan", { id: "vanished", name: "Vanished" });
    const roots = lineage([orphan]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.depth).toBe(0);
  });

  it("does not recurse forever on a cycle", () => {
    const x = agent("x", "X", { id: "y", name: "Y" });
    const y = agent("y", "Y", { id: "x", name: "X" });
    const flat = flattenLineage(lineage([x, y]));
    expect(flat.length).toBeLessThanOrEqual(2);
  });

  it("ignores an agent that claims to have created itself", () => {
    const self = agent("self", "Self", { id: "self", name: "Self" });
    expect(lineage([self])[0]!.depth).toBe(0);
  });

  it("reports attribution only when there is one", () => {
    expect(attribution(root)).toBeNull();
    expect(attribution(child)!.by.name).toBe("Root");
  });
});
