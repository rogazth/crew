import { rememberBots } from "./botNames";
import { describe, expect, it } from "vitest";
import { applyEvent, newBlock } from "./blocks";
import type { Block, ToolDetail, ToolStatus } from "./protocol";
import { hasBody, splitClip, toolLine } from "./toolDetail";

function tool(detail: ToolDetail | undefined, status: ToolStatus = "completed", title = "Bash"): Block {
  const block = newBlock("tool", title);
  block.tool = { callId: "c1", name: "Bash", title, status, ...(detail ? { detail } : {}) };
  return block;
}

describe("toolLine", () => {
  it("falls back to the provider title when a call carries no detail", () => {
    expect(toolLine(tool(undefined, "completed", "Read foo.ts"))).toEqual({
      text: "Read foo.ts",
      mono: false,
      failed: false,
    });
  });

  it("shows the command itself, not the tool name", () => {
    const line = toolLine(tool({ kind: "command", command: "npm run check", exitCode: 0 }));
    expect(line.text).toBe("npm run check");
    expect(line.mono).toBe(true);
    expect(line.failed).toBe(false);
  });

  it("marks a non-zero exit as failed even when the provider called it completed", () => {
    const line = toolLine(tool({ kind: "command", command: "npm test", exitCode: 1 }));
    expect(line.failed).toBe(true);
    expect(line.suffix).toBe("exit 1");
  });

  it("leaves a still-running command unmarked", () => {
    const line = toolLine(tool({ kind: "command", command: "sleep 5" }, "pending"));
    expect(line.failed).toBe(false);
    expect(line.suffix).toBeUndefined();
  });

  it("keeps only the first line of a heredoc", () => {
    const line = toolLine(tool({ kind: "command", command: "cat <<EOF\nbody\nEOF", exitCode: 0 }));
    expect(line.text).toBe("cat <<EOF");
  });

  it("shortens a long path and keeps the line range", () => {
    const line = toolLine(
      tool({ kind: "file", path: "/home/me/crew/src/lib/tabs.ts", lineStart: 12, lineEnd: 40 }),
    );
    expect(line.text).toBe("src/lib/tabs.ts");
    expect(line.suffix).toBe("12–40");
  });

  it("leaves a short path alone", () => {
    const line = toolLine(tool({ kind: "file", path: "src/App.tsx" }));
    expect(line.text).toBe("src/App.tsx");
    expect(line.suffix).toBeUndefined();
  });

  it("tallies an edit", () => {
    const line = toolLine(tool({ kind: "edit", path: "a/b/c/d.ts", added: 3, removed: 1 }));
    expect(line.suffix).toBe("+3 −1");
  });

  it("shows no tally when the provider never counted", () => {
    expect(toolLine(tool({ kind: "edit", path: "a.ts" })).suffix).toBeUndefined();
  });

  it("counts search matches in singular and plural", () => {
    expect(toolLine(tool({ kind: "search", query: "TODO", matches: 1 })).suffix).toBe("1 match");
    expect(toolLine(tool({ kind: "search", query: "TODO", matches: 7 })).suffix).toBe("7 matches");
    expect(toolLine(tool({ kind: "search", query: "TODO" })).suffix).toBeUndefined();
  });

  it("names the host of a fetch", () => {
    const line = toolLine(tool({ kind: "fetch", url: "https://example.com/a/b", title: "Example" }));
    expect(line.text).toBe("Example");
    expect(line.suffix).toBe("example.com");
  });

  it("survives a url it cannot parse", () => {
    expect(toolLine(tool({ kind: "fetch", url: "not a url" })).text).toBe("not a url");
  });

  it("says who a message went to", () => {
    const line = toolLine(tool({ kind: "message", to: "Cuddles", text: "done\nwith details" }));
    expect(line.text).toBe("done");
    expect(line.suffix).toBe("to Cuddles");
  });

  // list_agents hands the model ids, so half the message rows arrive as a uuid.
  it("says the name of the bot an id belongs to", () => {
    rememberBots([{ id: "4be7e9ad-a184", name: "Cuddles" }]);
    const line = toolLine(tool({ kind: "message", to: "4be7e9ad-a184", text: "done" }));
    expect(line.suffix).toBe("to Cuddles");
  });

  it("leaves an id it has never seen alone", () => {
    const line = toolLine(tool({ kind: "message", to: "nobody-here", text: "done" }));
    expect(line.suffix).toBe("to nobody-here");
  });
});

describe("hasBody", () => {
  it("opens a command that produced output", () => {
    expect(hasBody(tool({ kind: "command", command: "ls", exitCode: 0, output: "a\nb" }))).toBe(true);
  });

  it("does not open a command that printed nothing", () => {
    expect(hasBody(tool({ kind: "command", command: "true", exitCode: 0, output: "  " }))).toBe(false);
  });

  it("opens a multi-line command even with no output", () => {
    expect(hasBody(tool({ kind: "command", command: "a\nb", exitCode: 0 }))).toBe(true);
  });

  it("opens an edit only when it carries the diff", () => {
    expect(hasBody(tool({ kind: "edit", path: "a.ts", added: 1, removed: 0 }))).toBe(false);
    const hunks = [{ before: "a", after: "b" }];
    expect(hasBody(tool({ kind: "edit", path: "a.ts", added: 1, removed: 1, hunks }))).toBe(true);
  });

  it("does not open a one-line message", () => {
    expect(hasBody(tool({ kind: "message", to: "A", text: "ack" }))).toBe(false);
  });

  it("has nothing to open without a detail", () => {
    expect(hasBody(tool(undefined))).toBe(false);
  });
});

describe("splitClip", () => {
  it("separates the daemon's clip marker from the body", () => {
    expect(splitClip("body here\n… 240 more bytes")).toEqual({ body: "body here", dropped: 240 });
  });

  it("leaves untouched text alone", () => {
    expect(splitClip("all of it")).toEqual({ body: "all of it", dropped: null });
  });
});

// ---------------------------------------------------------------------------
// REVIEW additions: the client store applies harness events with
// `applyEvent` (src/lib/transcript.ts:109,121), so whatever it drops is what a
// live turn renders until the next full reload.
// ---------------------------------------------------------------------------
describe("REVIEW: the live client store and ToolDetail", () => {
  it("keeps the detail a tool.started carried", () => {
    const blocks = applyEvent([], {
      type: "tool.started",
      callId: "c1",
      name: "Bash",
      title: "npm test",
      detail: { kind: "command", command: "npm test" },
    });
    expect(blocks[0]?.tool?.detail).toEqual({ kind: "command", command: "npm test" });
  });

  it("lands the result detail a tool.updated carried", () => {
    const started = applyEvent([], {
      type: "tool.started",
      callId: "c1",
      name: "Bash",
      title: "npm test",
      detail: { kind: "command", command: "npm test" },
    });
    const done = applyEvent(started, {
      type: "tool.updated",
      callId: "c1",
      status: "completed",
      detail: { kind: "command", command: "npm test", exitCode: 1, output: "boom" },
    });
    expect(done[0]?.tool?.detail).toEqual({
      kind: "command",
      command: "npm test",
      exitCode: 1,
      output: "boom",
    });
  });

  it("renders the command, not the provider title, on a live row", () => {
    const blocks = applyEvent([], {
      type: "tool.started",
      callId: "c1",
      name: "Bash",
      title: "Bash",
      detail: { kind: "command", command: "npm run check", exitCode: 0 },
    });
    expect(toolLine(blocks[0]!).text).toBe("npm run check");
  });
});

describe("a result with no shape of its own", () => {
  it("is named by its tool, not by the first line of what it answered", () => {
    const row = tool({ kind: "output", text: '[\n  {"id": "a"}\n]' }, "completed", "Crew list agents");
    expect(toolLine(row).text).toBe("Crew list agents");
    expect(hasBody(row)).toBe(true);
  });

  it("reads an old transcript's raw MCP name as its server and tool", () => {
    const row = tool({ kind: "output", text: "{}" }, "completed", "mcp__chrome-devtools__take_snapshot");
    expect(toolLine(row).text).toBe("chrome-devtools · take snapshot");
  });

  it("has nothing to open when it answered blank", () => {
    expect(hasBody(tool({ kind: "output", text: "  " }))).toBe(false);
  });
});

describe("the shaped tools", () => {
  it("says what a checklist is on and how far along it is", () => {
    const line = toolLine(
      tool({
        kind: "todo",
        items: [
          { text: "Write it", status: "completed" },
          { text: "Test it", status: "inProgress" },
          { text: "Ship it", status: "pending" },
        ],
      }),
    );
    expect(line).toMatchObject({ text: "Test it", suffix: "1/3 done" });
  });

  it("names a subagent by its task and its kind", () => {
    const line = toolLine(tool({ kind: "agent", description: "Find the parser", agentType: "Explore" }));
    expect(line).toMatchObject({ text: "Find the parser", suffix: "Explore", mono: false });
  });

  it("names an MCP call by its server and tool", () => {
    const row = tool({ kind: "mcp", server: "claude_ai_Notion", tool: "notion-fetch", output: "{}" });
    expect(toolLine(row).text).toBe("Notion · notion fetch");
    expect(hasBody(row)).toBe(true);
  });
});
