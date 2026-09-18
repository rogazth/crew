/**
 * The fixtures are the shared ground the three prototypes are compared on. A
 * broken one is three broken prototypes, and the breakage looks like a design
 * problem rather than a data problem. So they get checked like code.
 */
import { describe, expect, it } from "vitest";
import { projectFiles, sessions, workspaces } from "./data/workspace";
import { threads } from "./data/threads";
import { routines } from "./data/routines";
import { terminalBuffers } from "./data/terminal";
import { FILE_CONTENTS, diffs } from "./data/files";
import { MARKDOWN_KITCHEN_SINK } from "./data/markdown";
import { buildActivity, groupRows } from "./transcript";
import { isOpen, toolLine } from "./toolDetail";
import { graph, lineage, flattenLineage, mailbox, rosterFrom } from "./agents";
import { searchMessages, snippetRuns } from "./search";
import { fuzzyMatch, highlightRuns, rankBy } from "./fuzzy";
import { stressThread, stressSessions, stressFiles, hugeTable, stressWorld } from "./data/stress";
import { PROVIDERS, modelsOf, providerLine } from "./data/providers";

const agentName = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;

describe("the world hangs together", () => {
  it("gives every session a workspace that exists", () => {
    const ids = new Set(workspaces.map((w) => w.id));
    for (const session of sessions) expect(ids.has(session.workspaceId), session.name).toBe(true);
  });

  it("gives every session a provider and, if an agent, a model that exists", () => {
    for (const session of sessions) {
      expect(PROVIDERS.some((p) => p.id === session.provider), session.name).toBe(true);
      if (session.kind !== "agent") continue;
      const models = modelsOf(session.provider).map((m) => m.id);
      expect(models, `${session.name} / ${session.model}`).toContain(session.model);
    }
  });

  it("points every createdBy at a session that exists", () => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const session of sessions) {
      if (!session.createdBy) continue;
      expect(ids.has(session.createdBy.id), `${session.name} ← ${session.createdBy.name}`).toBe(true);
      expect(session.createdBy.name).toBe(agentName(session.createdBy.id));
    }
  });

  it("points every routine at a session that exists", () => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const routine of routines) expect(ids.has(routine.sessionId), routine.name).toBe(true);
  });

  it("points every terminal buffer at a terminal session", () => {
    for (const id of Object.keys(terminalBuffers)) {
      const session = sessions.find((s) => s.id === id);
      expect(session, id).toBeTruthy();
      expect(session!.kind).toBe("terminal");
    }
  });

  it("gives every agent session a thread entry, even an empty one", () => {
    for (const session of sessions) {
      if (session.kind !== "agent") continue;
      expect(threads[session.id], session.name).toBeDefined();
    }
  });

  it("never lets a thread name a sender that does not exist", () => {
    const ids = new Set(sessions.map((s) => s.id));
    for (const [sessionId, blocks] of Object.entries(threads)) {
      for (const block of blocks) {
        if (!block.fromAgent) continue;
        expect(ids.has(block.fromAgent.id), `${sessionId} ← ${block.fromAgent.id}`).toBe(true);
      }
    }
  });

  it("keeps every thread in chronological order", () => {
    for (const [sessionId, blocks] of Object.entries(threads)) {
      const stamps = blocks.map((b) => b.at ?? 0).filter(Boolean);
      const sorted = [...stamps].sort((a, b) => a - b);
      expect(stamps, sessionId).toEqual(sorted);
    }
  });

  it("gives every block a unique id", () => {
    const seen = new Set<string>();
    for (const blocks of Object.values(threads)) {
      for (const block of blocks) {
        expect(seen.has(block.id), block.id).toBe(false);
        seen.add(block.id);
      }
    }
  });
});

describe("the demo covers what the brief promised", () => {
  it("has a long thread, a short one and an empty one", () => {
    expect(threads["s-harness"]!.length).toBeGreaterThan(40);
    expect(threads["s-renderer"]!.length).toBeLessThan(15);
    expect(threads["s-triage"]).toHaveLength(0);
  });

  it("has a run long enough that folding has to work", () => {
    // What makes `s-daemon` the stress case is not its block count but its
    // longest unbroken phase: a dozen reads that must fold to one line.
    const items = buildActivity(threads["s-daemon"]!.filter((b) => b.role === "tool"));
    const longest = Math.max(
      ...items.map((item) => (item.kind === "phase" ? item.phase.blocks.length : 0)),
    );
    expect(longest).toBeGreaterThanOrEqual(10);
  });

  it("has every block role somewhere", () => {
    const roles = new Set(Object.values(threads).flat().map((b) => b.role));
    for (const role of ["user", "assistant", "reasoning", "tool", "approval", "question", "system"]) {
      expect(roles, role).toContain(role);
    }
  });

  it("has every tool detail kind somewhere", () => {
    const kinds = new Set(
      Object.values(threads)
        .flat()
        .map((b) => b.tool?.detail?.kind)
        .filter(Boolean),
    );
    for (const kind of ["command", "file", "edit", "search", "fetch", "message", "output"]) {
      expect(kinds, kind).toContain(kind);
    }
  });

  it("has an open approval and an open question to demo", () => {
    const open = Object.values(threads).flat().filter(isOpen);
    expect(open.some((b) => b.role === "approval")).toBe(true);
    expect(open.some((b) => b.role === "question")).toBe(true);
    expect(open.some((b) => b.role === "tool")).toBe(true);
  });

  it("has a failed tool call and an interrupted session", () => {
    const blocks = Object.values(threads).flat();
    expect(blocks.some((b) => b.tool?.status === "failed")).toBe(true);
    expect(blocks.some((b) => b.role === "system")).toBe(true);
  });

  it("has attachments, mentions and usage", () => {
    const blocks = Object.values(threads).flat();
    expect(blocks.some((b) => b.files?.length)).toBe(true);
    expect(blocks.some((b) => b.usage?.costUsd !== undefined)).toBe(true);
  });

  it("exercises every markdown feature the transcript has to paint", () => {
    for (const mark of ["| ---", "```ts", "```diff", "> ", "- [x]", "[^1]", "~~", "## "]) {
      expect(MARKDOWN_KITCHEN_SINK, mark).toContain(mark);
    }
  });

  it("ships file bodies and patches for the editor and the diff surface", () => {
    expect(Object.keys(FILE_CONTENTS).length).toBeGreaterThanOrEqual(4);
    expect(diffs.length).toBeGreaterThanOrEqual(3);
    for (const diff of diffs) expect(diff.patch).toContain("@@");
  });
});

describe("no row in the whole demo reads as raw JSON", () => {
  it("gives every tool block a sentence", () => {
    for (const [sessionId, blocks] of Object.entries(threads)) {
      for (const block of blocks) {
        if (block.role !== "tool") continue;
        const line = toolLine(block, agentName);
        expect(line.text.trim().length, `${sessionId} / ${block.tool?.name}`).toBeGreaterThan(0);
        expect(line.text.trimStart().startsWith("{"), `${sessionId} / ${block.tool?.name}`).toBe(false);
        expect(line.text.trimStart().startsWith("["), `${sessionId} / ${block.tool?.name}`).toBe(false);
      }
    }
  });

  it("reads the captured real run the way FINDINGS says it should", () => {
    const rows = threads["s-lead"]!.filter((b) => b.role === "tool").map((b) =>
      toolLine(b, agentName).text,
    );
    expect(rows).toEqual([
      "Looked at the roster",
      "Looked for a tool",
      "Created reviewer",
      "Wrote to reviewer",
    ]);
  });

  it("groups every thread without throwing", () => {
    for (const [sessionId, blocks] of Object.entries(threads)) {
      const rows = groupRows(blocks, { resolveAgent: agentName });
      expect(rows.length, sessionId).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the agent network the prototypes render", () => {
  const roster = rosterFrom(sessions, threads);

  it("has letters in several directions", () => {
    const g = graph(roster);
    expect(g.edges.length).toBeGreaterThanOrEqual(5);
    expect(new Set(g.edges.map((e) => e.from.id)).size).toBeGreaterThanOrEqual(3);
  });

  it("leaves something in a box, so the mailbox has something to show", () => {
    expect(mailbox(roster, "s-harness").length).toBeGreaterThan(0);
  });

  it("goes at least four levels deep, so a tree is worth drawing", () => {
    const depth = Math.max(...flattenLineage(lineage(sessions)).map((n) => n.depth));
    expect(depth).toBeGreaterThanOrEqual(3);
  });

  it("shows an agent creating another agent", () => {
    const creations = Object.values(threads)
      .flat()
      .filter((b) => (b.tool?.name ?? "").includes("create_agent"));
    expect(creations.length).toBeGreaterThanOrEqual(2);
  });
});

describe("search and ranking", () => {
  it("finds a word that is in the transcripts", () => {
    const hits = searchMessages({ query: "provider" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain("");
  });

  it("finds nothing for nothing", () => {
    expect(searchMessages({ query: "   " })).toHaveLength(0);
    expect(searchMessages({ query: "zzzzzqqqqq" })).toHaveLength(0);
  });

  it("scopes to a session when asked", () => {
    const hits = searchMessages({ query: "el", sessionIds: ["s-renderer"] });
    for (const hit of hits) expect(hit.sessionId).toBe("s-renderer");
  });

  it("orders by time when asked for newest", () => {
    const hits = searchMessages({ query: "a", sort: "newest", limit: 20 });
    const stamps = hits.map((h) => h.at);
    expect(stamps).toEqual([...stamps].sort((x, y) => y - x));
  });

  it("splits a snippet into plain and matched runs", () => {
    const runs = snippetRuns("beforehitafter");
    expect(runs).toEqual([
      { text: "before", hit: false },
      { text: "hit", hit: true },
      { text: "after", hit: false },
    ]);
  });

  it("leaves an unmarked snippet whole", () => {
    expect(snippetRuns("plain")).toEqual([{ text: "plain", hit: false }]);
  });

  it("matches a subsequence and prefers word boundaries", () => {
    expect(fuzzyMatch("tabs", "src/lib/tabs.ts")).not.toBeNull();
    expect(fuzzyMatch("zzz", "src/lib/tabs.ts")).toBeNull();
    const boundary = fuzzyMatch("slt", "src/lib/tabs.ts")!.score;
    const scattered = fuzzyMatch("slt", "sxxlxxtxx")!.score;
    expect(boundary).toBeGreaterThan(scattered);
  });

  it("ranks the file you meant first", () => {
    const ranked = rankBy(projectFiles, "libtabs", (f) => f.relative);
    expect(ranked[0]!.relative).toBe("src/lib/tabs.ts");
  });

  it("turns match positions into runs for highlighting", () => {
    const hit = fuzzyMatch("ab", "xaxb")!;
    expect(highlightRuns("xaxb", hit.positions).map((r) => r.text).join("")).toBe("xaxb");
    expect(highlightRuns("xaxb", hit.positions).filter((r) => r.hit).length).toBe(2);
  });
});

describe("stress fixtures", () => {
  it("is deterministic — two runs produce the same world", () => {
    const one = stressThread({ blocks: 200, seed: 3 });
    const two = stressThread({ blocks: 200, seed: 3 });
    expect(one.map((b) => b.role)).toEqual(two.map((b) => b.role));
    expect(one.length).toBe(200);
  });

  it("produces a mix, not a thousand identical rows", () => {
    const blocks = stressThread({ blocks: 1_000, seed: 5 });
    const roles = new Set(blocks.map((b) => b.role));
    expect(roles.size).toBeGreaterThanOrEqual(4);
    const tools = blocks.filter((b) => b.role === "tool");
    expect(new Set(tools.map((b) => b.tool?.detail?.kind)).size).toBeGreaterThanOrEqual(3);
  });

  it("stays in chronological order", () => {
    const stamps = stressThread({ blocks: 500, seed: 9 }).map((b) => b.at ?? 0);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it("groups without throwing at five thousand blocks", () => {
    const rows = groupRows(stressThread({ blocks: 5_000, seed: 11 }));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("builds a lineage rather than a flat list", () => {
    const list = stressSessions(200);
    expect(list.filter((s) => s.createdBy).length).toBeGreaterThan(20);
    const depth = Math.max(...flattenLineage(lineage(list)).map((n) => n.depth));
    expect(depth).toBeGreaterThanOrEqual(2);
  });

  it("makes a table too wide and too long for any column", () => {
    const table = hugeTable(500, 12);
    expect(table.split("\n")).toHaveLength(502);
  });

  it("makes twenty thousand unique-ish file paths", () => {
    const files = stressFiles(20_000);
    expect(files).toHaveLength(20_000);
    expect(new Set(files.map((f) => f.relative)).size).toBeGreaterThan(5_000);
  });

  it("assembles a whole world per preset", () => {
    const world = stressWorld("medium");
    expect(world.sessions.length).toBe(150);
    expect(Object.keys(world.threads)).toHaveLength(3);
  });

  it("builds each part only when it is read", () => {
    // Eagerly, `heavy` is 20k paths and 15k blocks in one synchronous burst,
    // which a performance trace blames on whatever rendered next.
    const started = performance.now();
    const world = stressWorld("heavy");
    expect(performance.now() - started).toBeLessThan(5);

    const id = world.sessions[0]!.id;
    expect(world.threads[id]).toHaveLength(5_000);
    // And the second read is the same array, not a second build.
    expect(world.threads[id]).toBe(world.threads[id]);
  });

  it("answers undefined for a session that has no stress transcript", () => {
    const world = stressWorld("light");
    expect(world.threads["nope"]).toBeUndefined();
    expect("nope" in world.threads).toBe(false);
  });
});

describe("providers", () => {
  it("labels a session's model for the sidebar", () => {
    expect(providerLine("claude", "claude-opus-5")).toBe("Claude Opus 5");
    expect(providerLine("opencode", "opencode/ling-3.0-flash-fin-free")).toBe(
      "opencode Ling 3.0 Flash",
    );
  });

  it("leaves an unknown model as its id rather than lying", () => {
    expect(providerLine("claude", "made-up")).toBe("Claude made-up");
  });
});
