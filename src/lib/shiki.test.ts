import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";

const shiki = vi.hoisted(() => {
  const core = {
    loadLanguage: vi.fn(async (_load: unknown) => {}),
    codeToHtml: vi.fn((code: string, _options: unknown) => `<span>${code}</span>`),
  };
  const grammar = (name: string) => vi.fn(async () => ({ name }));
  return {
    core,
    createHighlighterCore: vi.fn(async (_options: unknown) => core),
    createJavaScriptRegexEngine: vi.fn(() => "js-engine"),
    bundledLanguages: {
      typescript: grammar("typescript"),
      python: grammar("python"),
    } as Record<string, () => Promise<unknown>>,
  };
});

vi.mock("shiki/core", () => ({ createHighlighterCore: shiki.createHighlighterCore }));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: shiki.createJavaScriptRegexEngine }));
vi.mock("@shikijs/themes/min-light", () => ({ default: { name: "min-light" } }));
vi.mock("@shikijs/themes/min-dark", () => ({ default: { name: "min-dark" } }));
vi.mock("shiki", () => ({ bundledLanguages: shiki.bundledLanguages }));

async function load() {
  return import("./shiki");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  shiki.core.loadLanguage.mockImplementation(async () => {});
  shiki.createHighlighterCore.mockImplementation(async () => shiki.core);
});

describe("resolveLang", () => {
  it("keeps a curated language id", async () => {
    const { resolveLang } = await load();
    expect(resolveLang("typescript")).toBe("typescript");
    expect(resolveLang("tsx")).toBe("tsx");
    expect(resolveLang("diff")).toBe("diff");
  });

  it("maps the fence aliases people type to their grammar", async () => {
    const { resolveLang } = await load();
    expect(["sh", "bash", "zsh", "shell"].map(resolveLang)).toEqual(Array(4).fill("shellscript"));
    expect(["js", "mjs", "cjs"].map(resolveLang)).toEqual(Array(3).fill("javascript"));
    expect(["ts", "mts"].map(resolveLang)).toEqual(["typescript", "typescript"]);
    expect(resolveLang("yml")).toBe("yaml");
    expect(resolveLang("md")).toBe("markdown");
    expect(resolveLang("py")).toBe("python");
    expect(resolveLang("rb")).toBe("ruby");
    expect(resolveLang("rs")).toBe("rust");
    expect(resolveLang("docker")).toBe("dockerfile");
  });

  it("ignores case", async () => {
    const { resolveLang } = await load();
    expect(resolveLang("TypeScript")).toBe("typescript");
    expect(resolveLang("BASH")).toBe("shellscript");
  });

  it("gives nothing for a missing, empty or uncurated language", async () => {
    const { resolveLang } = await load();
    expect(resolveLang(undefined)).toBeNull();
    expect(resolveLang("")).toBeNull();
    expect(resolveLang("text")).toBeNull();
    expect(resolveLang("cobol")).toBeNull();
  });
});

describe("highlightInline", () => {
  it("renders inline spans with both themes as CSS variables", async () => {
    const { THEMES, highlightInline } = await load();
    expect(await highlightInline("let a = 1", "typescript")).toBe("<span>let a = 1</span>");
    expect(shiki.core.codeToHtml).toHaveBeenCalledWith("let a = 1", {
      lang: "typescript",
      themes: THEMES,
      defaultColor: false,
      structure: "inline",
    });
  });

  it("builds one highlighter, with both themes, no grammars and the JavaScript regex engine", async () => {
    const { highlightInline } = await load();
    await Promise.all([highlightInline("a", "typescript"), highlightInline("b", "python")]);
    await highlightInline("c", "typescript");
    expect(shiki.createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(shiki.createHighlighterCore).toHaveBeenCalledWith({
      themes: [{ name: "min-light" }, { name: "min-dark" }],
      langs: [],
      engine: "js-engine",
    });
  });

  it("loads a grammar on first use only", async () => {
    const { highlightInline } = await load();
    await highlightInline("a", "typescript");
    await highlightInline("b", "typescript");
    await highlightInline("c", "python");
    expect(shiki.core.loadLanguage).toHaveBeenCalledTimes(2);
    expect(shiki.core.loadLanguage).toHaveBeenNthCalledWith(1, shiki.bundledLanguages.typescript);
    expect(shiki.core.loadLanguage).toHaveBeenNthCalledWith(2, shiki.bundledLanguages.python);
  });

  it("loads a grammar once when two blocks ask for it at the same time", async () => {
    const gate = deferred();
    shiki.core.loadLanguage.mockImplementation(() => gate.promise);
    const { highlightInline } = await load();
    const first = highlightInline("a", "typescript");
    const second = highlightInline("b", "typescript");
    await vi.waitFor(() => expect(shiki.core.loadLanguage).toHaveBeenCalled());
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(["<span>a</span>", "<span>b</span>"]);
    expect(shiki.core.loadLanguage).toHaveBeenCalledTimes(1);
  });

  it("gives null for a language shiki has no grammar for", async () => {
    const { highlightInline } = await load();
    expect(await highlightInline("x", "cobol")).toBeNull();
    expect(shiki.core.loadLanguage).not.toHaveBeenCalled();
    expect(shiki.core.codeToHtml).not.toHaveBeenCalled();
  });

  it("gives null when the grammar fails to load", async () => {
    shiki.core.loadLanguage.mockRejectedValue(new Error("chunk failed"));
    const { highlightInline } = await load();
    expect(await highlightInline("x", "python")).toBeNull();
    expect(shiki.core.codeToHtml).not.toHaveBeenCalled();
  });
});
