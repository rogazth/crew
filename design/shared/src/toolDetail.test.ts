import { describe, expect, it } from "vitest";
import { hasBody, splitClip, toolLine } from "./toolDetail";
import { crewTool, crewToolLine, innerToolFromTitle } from "./crewTools";
import type { Block, ToolDetail, ToolStatus } from "./types";

function toolBlock(
  name: string,
  title: string,
  detail?: ToolDetail,
  status: ToolStatus = "completed",
  args?: Record<string, unknown>,
): Block {
  return {
    id: "b1",
    role: "tool",
    text: title,
    tool: { callId: "c1", name, title, status, ...(detail ? { detail } : {}), ...(args ? { args } : {}) },
  };
}

describe("toolLine — the row must always be a sentence", () => {
  it("never prints a provider's raw JSON input", () => {
    const block = toolBlock("some_tool", '{"path":"/tmp/x","mode":"w"}');
    expect(toolLine(block).text).toBe("Used some tool");
  });

  it("never prints a raw JSON array either", () => {
    expect(toolLine(toolBlock("weird", "[1,2,3]")).text).toBe("Used weird");
  });

  it("keeps a title the provider made readable", () => {
    expect(toolLine(toolBlock("Read", "Read src/App.tsx")).text).toBe("Read src/App.tsx");
  });

  it("humanises snake_case and camelCase names", () => {
    expect(toolLine(toolBlock("apply_patch", "{}")).text).toBe("Used apply patch");
    expect(toolLine(toolBlock("readTextFile", "{}")).text).toBe("Used read Text File");
  });

  it("shortens a path to its last three segments", () => {
    const block = toolBlock("Read", "Read", {
      kind: "file",
      path: "/Users/me/crew/src/lib/tabs.ts",
      lineStart: 1,
      lineEnd: 40,
    });
    const line = toolLine(block);
    expect(line.text).toBe("src/lib/tabs.ts");
    expect(line.suffix).toBe("1–40");
    expect(line.mono).toBe(true);
  });

  it("marks a non-zero exit as failed and says the code", () => {
    const block = toolBlock("Bash", "npm test", {
      kind: "command",
      command: "npm test",
      exitCode: 1,
      output: "boom",
    });
    const line = toolLine(block);
    expect(line.failed).toBe(true);
    expect(line.suffix).toBe("exit 1");
  });

  it("tallies an edit", () => {
    const line = toolLine(
      toolBlock("Edit", "Edit", { kind: "edit", path: "a/b/c.ts", added: 6, removed: 2 }),
    );
    expect(line.suffix).toBe("+6 −2");
  });

  it("pluralises search matches", () => {
    expect(toolLine(toolBlock("Grep", "g", { kind: "search", query: "x", matches: 1 })).suffix).toBe(
      "1 match",
    );
    expect(toolLine(toolBlock("Grep", "g", { kind: "search", query: "x", matches: 9 })).suffix).toBe(
      "9 matches",
    );
  });
});

describe("Crew tools — the rows the app renders worst", () => {
  it("recognises every provider's prefix", () => {
    expect(crewTool("mcp__crew__create_agent")).toBe("create_agent");
    expect(crewTool("crew_create_agent")).toBe("create_agent");
    expect(crewTool("crew.create_agent")).toBe("create_agent");
    expect(crewTool("create_agent")).toBe("create_agent");
    expect(crewTool("Bash")).toBeNull();
  });

  it("recovers the inner tool from a gateway title", () => {
    expect(innerToolFromTitle("Crew call tool create_agent")).toBe("create_agent");
    expect(innerToolFromTitle("crew call_tool message_agent")).toBe("message_agent");
    expect(innerToolFromTitle("Crew list agents")).toBeNull();
  });

  it("reads create_agent from its arguments", () => {
    const line = crewToolLine("mcp__crew__create_agent", {
      name: "reviewer",
      description: "Reviews PRs.",
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    expect(line?.text).toBe("Created reviewer");
    // A model id is an address; the row shows the name.
    expect(line?.suffix).toBe("Codex GPT-5.6 Sol");
    expect(line?.body).toBe("Reviews PRs.");
  });

  it("reads create_agent from the daemon's result when arguments are absent", () => {
    const line = crewToolLine("crew_call_tool", undefined, undefined, {
      title: "Crew call tool create_agent",
      output: JSON.stringify({
        id: "600cbf85",
        name: "reviewer",
        provider: "opencode",
        model: "opencode/ling-3.0-flash-fin-free",
        status: "idle",
      }),
    });
    expect(line?.text).toBe("Created reviewer");
    expect(line?.peerId).toBe("600cbf85");
  });

  it("reads message_agent from the result, including the mailbox depth", () => {
    const line = crewToolLine("crew_call_tool", undefined, undefined, {
      title: "Crew call tool message_agent",
      output: JSON.stringify({ delivered: true, to: "reviewer", waiting: 2 }),
    });
    expect(line?.text).toBe("Wrote to reviewer");
    expect(line?.suffix).toBe("→ reviewer · 2 ahead");
  });

  it("omits the queue note when nothing is ahead", () => {
    const line = crewToolLine("crew_call_tool", undefined, undefined, {
      title: "Crew call tool message_agent",
      output: JSON.stringify({ delivered: true, to: "reviewer", waiting: 0 }),
    });
    expect(line?.suffix).toBe("→ reviewer");
  });

  it("resolves an agent id to its name", () => {
    const line = crewToolLine(
      "crew_message_agent",
      { to: "s-relay", text: "ping" },
      (id) => (id === "s-relay" ? "Relay" : id),
    );
    expect(line?.suffix).toBe("→ Relay");
    expect(line?.peerId).toBe("s-relay");
  });

  it("describes a routine schedule in words", () => {
    const line = crewToolLine("crew_upsert_routine", {
      name: "Nightly digest",
      schedule: { kind: "daily", hour: 22, minute: 30, days: [] },
      prompt: "Summarise the day.",
    });
    expect(line?.text).toBe('Created routine “Nightly digest”');
    expect(line?.suffix).toBe("daily at 22:30");
  });

  it("says weekdays when the schedule is Monday to Friday", () => {
    const line = crewToolLine("crew_upsert_routine", {
      name: "Triage",
      routine_id: "r1",
      schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] },
    });
    expect(line?.text).toBe('Updated routine “Triage”');
    expect(line?.suffix).toBe("weekdays at 09:00");
  });

  it("survives a result that is not JSON", () => {
    const line = crewToolLine("crew_call_tool", undefined, undefined, {
      title: "Crew call tool create_agent",
      output: "not json at all",
    });
    // Falls back to the generic label rather than throwing or printing the blob.
    expect(line?.text).toBe("Created an agent");
  });

  it("gives every remaining Crew tool a sentence", () => {
    const names = [
      "list_agents",
      "continue_after_turn",
      "update_description",
      "search_messages",
      "list_routines",
      "delete_routine",
      "find_tool",
    ];
    for (const name of names) {
      const line = crewToolLine(`crew_${name}`, {});
      expect(line, name).not.toBeNull();
      expect(line!.text.length, name).toBeGreaterThan(4);
      expect(line!.text.startsWith("{"), name).toBe(false);
    }
  });

  it("keeps a properly normalised letter over the generic crew label", () => {
    // Measured: a direct `crew_message_agent` call does get a `message` detail,
    // and the letter's own text beats "Messaged an agent".
    const block = toolBlock("crew_message_agent", "Crew message agent", {
      kind: "message",
      to: "s-relay",
      text: "Tomá el seam de proveedores.",
    });
    expect(toolLine(block).text).toBe("Tomá el seam de proveedores.");
  });

  it("routes a whole captured row through toolLine", () => {
    const block = toolBlock("crew_call_tool", "Crew call tool create_agent", {
      kind: "output",
      text: JSON.stringify({ name: "reviewer", provider: "opencode", model: "ling" }),
    });
    expect(toolLine(block).text).toBe("Created reviewer");
  });
});

describe("hasBody", () => {
  it("opens for command output and closes for a bare command", () => {
    expect(hasBody(toolBlock("Bash", "x", { kind: "command", command: "ls", output: "a" }))).toBe(true);
    expect(hasBody(toolBlock("Bash", "x", { kind: "command", command: "ls" }))).toBe(false);
  });

  it("opens for a create_agent whose description we hold", () => {
    const block = toolBlock("crew_create_agent", "t", undefined, "completed", {
      name: "r",
      description: "Reviews PRs.",
    });
    expect(hasBody(block)).toBe(true);
  });
});

describe("splitClip", () => {
  it("leaves short output alone", () => {
    expect(splitClip("hello")).toEqual({ body: "hello", dropped: null });
  });

  it("cuts long output and reports the remainder", () => {
    const { body, dropped } = splitClip("x".repeat(9_000));
    expect(body.length).toBe(8_000);
    expect(dropped).toBe(1_000);
  });
});
