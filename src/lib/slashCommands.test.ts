import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandCatalog, CommandEntry } from "./protocol";

const request = vi.fn();
const on = vi.fn();
const onReconnect = vi.fn();
vi.mock("./client", () => ({ client: { request, on, onReconnect } }));

const entry = (name: string, kind: CommandEntry["kind"], extra: Partial<CommandEntry> = {}): CommandEntry => ({
  name,
  description: `${name} does its thing`,
  kind,
  ...extra,
});

const ENTRIES: CommandEntry[] = [
  entry("model", "crew"),
  entry("restart", "crew"),
  entry("writing-for-agents", "skill", { path: "/w/.claude/skills/writing-for-agents/SKILL.md" }),
  entry("prototype", "skill"),
  entry("compact", "command", { argumentHint: "<hint>" }),
  entry("usage", "command", { aliases: ["cost"] }),
];

const names = (found: CommandEntry[]) => found.map((hit) => hit.name);

/** The one the bridge registered for "commands-changed". */
function remote(): (payload: unknown) => void {
  const hook = on.mock.calls.find(([event]) => event === "commands-changed");
  if (!hook) throw new Error("the bridge never subscribed");
  return hook[1] as (payload: unknown) => void;
}

const flush = () => new Promise((done) => setTimeout(done, 0));

async function slash() {
  return import("./slashCommands");
}

beforeEach(() => {
  vi.resetModules();
  request.mockReset();
  on.mockReset();
  onReconnect.mockReset();
});

describe("slashAt", () => {
  it("finds the word the caret is in", async () => {
    const { slashAt } = await slash();
    expect(slashAt("then /writ", 10)).toEqual({ start: 5, end: 10, query: "writ" });
    expect(slashAt("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(slashAt("/compact now", 4)).toEqual({ start: 0, end: 8, query: "com" });
  });

  it("ignores slashes inside a word or a path, and words the caret has left", async () => {
    const { slashAt } = await slash();
    expect(slashAt("src/lib", 7)).toBeNull();
    expect(slashAt("see /usr/bin", 12)).toBeNull();
    expect(slashAt("https://host", 12)).toBeNull();
    expect(slashAt("/compact now", 12)).toBeNull();
  });
});

describe("searchCommands", () => {
  it("lists everything at the start of a message, and without commands anywhere else", async () => {
    const { searchCommands } = await slash();
    expect(names(searchCommands(ENTRIES, "", true))).toEqual(["model", "restart", "writing-for-agents", "prototype", "compact", "usage"]);
    expect(names(searchCommands(ENTRIES, "", false))).toEqual(["model", "restart", "writing-for-agents", "prototype"]);
    expect(names(searchCommands(ENTRIES, "comp", false))).toEqual([]);
    expect(names(searchCommands(ENTRIES, "comp", true))).toEqual(["compact"]);
  });

  it("matches the way files do: letters in order, the best first", async () => {
    const { searchCommands } = await slash();
    expect(names(searchCommands(ENTRIES, "wfa", true))).toEqual(["writing-for-agents"]);
    expect(names(searchCommands(ENTRIES, "r", true))[0]).toBe("restart");
    expect(searchCommands(ENTRIES, "zzz", true)).toEqual([]);
  });

  it("matches an alias, and shows the entry it names", async () => {
    const { searchCommands } = await slash();
    expect(names(searchCommands(ENTRIES, "cost", true))).toEqual(["usage"]);
  });
});

describe("splitTokens", () => {
  it("cuts the text around the skills and commands it names", async () => {
    const { splitTokens } = await slash();
    expect(splitTokens("/compact the thread, then /prototype it", ENTRIES)).toEqual([
      { kind: "token", name: "compact", text: "/compact" },
      { kind: "text", text: " the thread, then " },
      { kind: "token", name: "prototype", text: "/prototype" },
      { kind: "text", text: " it" },
    ]);
  });

  it("paints a command only as the first word, and never a Crew action or a name it does not know", async () => {
    const { splitTokens } = await slash();
    expect(splitTokens("run /compact /model /nope", ENTRIES)).toEqual([{ kind: "text", text: "run /compact /model /nope" }]);
    expect(splitTokens("  /compact", ENTRIES)).toEqual([
      { kind: "text", text: "  " },
      { kind: "token", name: "compact", text: "/compact" },
    ]);
  });

  it("leaves paths and glued slashes alone, and lets a sentence end on a name", async () => {
    const { splitTokens } = await slash();
    expect(splitTokens("open src/prototype and /prototype/x", ENTRIES)).toEqual([
      { kind: "text", text: "open src/prototype and /prototype/x" },
    ]);
    expect(splitTokens("use /prototype.", ENTRIES)).toEqual([
      { kind: "text", text: "use " },
      { kind: "token", name: "prototype", text: "/prototype" },
      { kind: "text", text: "." },
    ]);
  });

  it("paints an alias as the entry it names", async () => {
    const { splitTokens } = await slash();
    expect(splitTokens("/cost", ENTRIES)).toEqual([{ kind: "token", name: "usage", text: "/cost" }]);
  });
});

describe("dispatchOf", () => {
  it("names the command a message opens with and the skills it carries", async () => {
    const { dispatchOf } = await slash();
    expect(dispatchOf("/compact keep the schema", ENTRIES)).toEqual({ command: "compact", skills: [] });
    expect(dispatchOf("draft it with /prototype and /writing-for-agents, then /prototype", ENTRIES)).toEqual({
      skills: ["prototype", "writing-for-agents"],
    });
    expect(dispatchOf("/prototype make it", ENTRIES)).toEqual({ skills: ["prototype"] });
  });

  it("takes a command only at the start, an alias by the name it stands for, and nothing from a plain message", async () => {
    const { dispatchOf } = await slash();
    expect(dispatchOf("please /compact", ENTRIES)).toEqual({ skills: [] });
    expect(dispatchOf("/cost", ENTRIES)).toEqual({ command: "usage", skills: [] });
    expect(dispatchOf("/model", ENTRIES)).toEqual({ skills: [] });
    expect(dispatchOf("fix the bug", ENTRIES)).toEqual({ skills: [] });
    expect(dispatchOf("/compact", [])).toEqual({ skills: [] });
  });
});

describe("completeSlash and removeSlash", () => {
  it("swaps the query for the name and a space, the one there if it has one", async () => {
    const { completeSlash } = await slash();
    expect(completeSlash("do /prot now", 8, ENTRIES[3]!)).toEqual({ text: "do /prototype now", cursor: 14 });
    expect(completeSlash("do /prot", 8, ENTRIES[3]!)).toEqual({ text: "do /prototype ", cursor: 14 });
    expect(completeSlash("no slash", 3, ENTRIES[3]!)).toBeNull();
  });

  it("takes the word and the space after it out", async () => {
    const { removeSlash } = await slash();
    expect(removeSlash("/mod", 4)).toEqual({ text: "", cursor: 0 });
    expect(removeSlash("a /mod b", 6)).toEqual({ text: "a b", cursor: 2 });
  });
});

describe("the store", () => {
  const catalog = (at: number, ...entries: CommandEntry[]): CommandCatalog => ({ entries, at });

  it("asks the daemon for a session's catalog the first time it is watched", async () => {
    const { subscribeCommands, readCommands } = await slash();
    request.mockResolvedValue(catalog(1, ENTRIES[0]!));
    subscribeCommands("s1", () => {});
    expect(request).toHaveBeenCalledWith("commands_list", { sessionId: "s1" });
    await flush();
    expect(readCommands("s1")).toEqual(catalog(1, ENTRIES[0]!));
    expect(readCommands("s2")).toBeNull();
  });

  it("replaces the catalog with the whole one a push carries", async () => {
    const { subscribeCommands, readCommands } = await slash();
    request.mockResolvedValue(catalog(1, ENTRIES[0]!));
    const listener = vi.fn();
    subscribeCommands("s1", listener);
    await flush();
    remote()({ sessionId: "s1", catalog: catalog(2, ENTRIES[3]!) });
    expect(readCommands("s1")).toEqual(catalog(2, ENTRIES[3]!));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not let a read asked before a push overwrite that push", async () => {
    const { subscribeCommands, readCommands } = await slash();
    let answer: (found: CommandCatalog) => void = () => {};
    request.mockReturnValue(new Promise<CommandCatalog>((done) => (answer = done)));
    subscribeCommands("s1", () => {});
    remote()({ sessionId: "s1", catalog: catalog(2, ENTRIES[3]!) });
    answer(catalog(1, ENTRIES[0]!));
    await flush();
    expect(readCommands("s1")).toEqual(catalog(2, ENTRIES[3]!));
  });

  it("reads again for the sessions watched when the socket comes back", async () => {
    const { subscribeCommands } = await slash();
    request.mockResolvedValue(catalog(1));
    subscribeCommands("s1", () => {});
    subscribeCommands("s2", () => {});
    await flush();
    request.mockClear();
    const reconnected = onReconnect.mock.calls[0]![0] as (here?: (id: string) => boolean) => void;
    reconnected((id) => id === "s2");
    expect(request.mock.calls).toEqual([["commands_list", { sessionId: "s2" }]]);
  });
});
