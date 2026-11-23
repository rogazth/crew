import { describe, expect, it } from "vitest";
import { blankRows, engineName, type BlankContext, type BlankRow } from "./blankTab";
import { PROVIDERS, type ProviderId } from "./providers";
import type { Session } from "./types";

const installed = (...ids: ProviderId[]) => PROVIDERS.filter((provider) => ids.includes(provider.id));

const agent = (id: string, name: string, kind: Session["kind"] = "terminal", updatedAt = 1) =>
  ({ id, name, kind, provider: "claude", status: "idle", updatedAt }) as Session;

const page = (url: string, title = "") => ({ url, urlKey: url, title });

const GOOGLE = "https://www.google.com/search?q=%s";

function ctx(over: Partial<BlankContext> = {}): BlankContext {
  return {
    installed: installed("claude", "codex", "grok", "cursor"),
    choiceOf: (provider) => ({ provider, model: "", effort: "", access: "full" }),
    agents: [],
    history: [],
    searchTemplate: GOOGLE,
    ...over,
  };
}

const ids = (rows: BlankRow[]) => rows.map((row) => row.id);

describe("blankRows", () => {
  it("offers the kinds with nothing typed", () => {
    expect(ids(blankRows("", ctx()))).toEqual(["new:session", "new:browser", "new:terminal", "new:bot", "new:incognito"]);
    expect(ids(blankRows("   ", ctx()))).toEqual(["new:session", "new:browser", "new:terminal", "new:bot", "new:incognito"]);
  });

  it("sets an agent up in place of the Session row when no CLI is installed", () => {
    expect(ids(blankRows("", ctx({ installed: [] })))[0]).toBe("setup");
    expect(ids(blankRows("set", ctx({ installed: [] })))[0]).toBe("setup");
  });

  it("finds a kind by its name", () => {
    expect(ids(blankRows("term", ctx()))[0]).toBe("new:terminal");
    expect(ids(blankRows("inc", ctx()))[0]).toBe("new:incognito");
  });

  it("finds a provider by its name, and no model then", () => {
    const rows = blankRows("cod", ctx());
    expect(rows[0]).toMatchObject({ kind: "agent", by: "provider", choice: { provider: "codex" } });
    expect(rows.some((row) => row.id.startsWith("model:"))).toBe(false);
  });

  it("leaves a provider that is not installed out", () => {
    expect(blankRows("cod", ctx({ installed: installed("claude") })).some((row) => row.kind === "agent")).toBe(false);
  });

  it("finds models when no provider or kind answers, the named provider's own first", () => {
    for (const provider of ["claude", "cursor"] as const) {
      const first = blankRows(`${provider} opus`, ctx()).find((row) => row.kind === "agent");
      expect(first).toMatchObject({ by: "model", choice: { provider } });
    }
  });

  it("waits for three letters before looking at models", () => {
    expect(blankRows("so", ctx()).some((row) => row.id.startsWith("model:"))).toBe(false);
  });

  it("opens an existing session or bot, a name leading over the web", () => {
    const rows = blankRows("plan", ctx({ agents: [agent("b1", "Planner", "bot")] }));
    expect(ids(rows).slice(0, 2)).toEqual(["existing:b1", "search"]);
  });

  it("never offers a subagent", () => {
    const rows = blankRows("fix", ctx({ agents: [agent("c1", "Fix login", "child")] }));
    expect(rows.some((row) => row.kind === "existing")).toBe(false);
  });

  it("leads with the page when the words are plainly an address, names after", () => {
    const rows = blankRows("localhost:3000", ctx({ agents: [agent("s1", "localhost:3000 crash")] }));
    expect(ids(rows).slice(0, 3)).toEqual(["open", "search", "existing:s1"]);
    expect(rows[0]).toMatchObject({ url: "http://localhost:3000", title: "Open localhost:3000" });
  });

  it("searches for an address too, with the engine the browser uses", () => {
    const rows = blankRows("github.com", ctx({ searchTemplate: "https://duckduckgo.com/?q=%s" }));
    expect(rows.find((row) => row.kind === "search")).toEqual({
      id: "search",
      kind: "search",
      url: "https://duckduckgo.com/?q=github.com",
      engine: "DuckDuckGo",
    });
    expect(rows.find((row) => row.kind === "open")).toMatchObject({ url: "https://github.com" });
  });

  it("offers a dotted name as a page below what it names", () => {
    const rows = blankRows("notes.md", ctx({ agents: [agent("s1", "notes.md review")] }));
    expect(ids(rows).slice(0, 3)).toEqual(["existing:s1", "open", "search"]);
  });

  it("completes what was typed to a visited address, keeping the row in its place", () => {
    const before = blankRows("localhost:30", ctx());
    const after = blankRows("localhost:30", ctx({ history: [page("http://localhost:3001/login", "Login")] }));
    expect(before[0]).toMatchObject({ id: "open", url: "http://localhost:30" });
    expect(after[0]).toMatchObject({ id: "open", url: "http://localhost:3001/", title: "Open localhost:3001" });
  });

  it("lists history under the actions, without the page the open row already opens", () => {
    const history = [page("http://localhost:3001/", "App"), page("http://localhost:3001/login", "Login"), page("http://localhost:3002/", "")];
    const rows = blankRows("localhost:300", ctx({ history }));
    expect(rows.filter((row) => row.kind === "page").map((row) => row.url)).toEqual([
      "http://localhost:3001/login",
      "http://localhost:3002/",
    ]);
    expect(rows.at(-1)).toMatchObject({ title: "localhost:3002", detail: "" });
    const untitled = blankRows("example", ctx({ history: [page("https://example.com/a", "example.com/a")] }));
    expect(untitled.find((row) => row.kind === "page")).toMatchObject({ title: "example.com/a", detail: "" });
  });
});

describe("engineName", () => {
  it("names a known engine, else the template's host", () => {
    expect(engineName(GOOGLE)).toBe("Google");
    expect(engineName("https://www.example.org/find?q=%s")).toBe("example.org");
  });
});
