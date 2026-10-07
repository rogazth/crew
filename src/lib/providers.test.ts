import { describe, expect, it } from "vitest";
import {
  choiceForNewSession,
  effortsOf,
  findModel,
  fitChoice,
  groupListed,
  modelLabel,
  modelsOf,
  PROVIDERS,
  searchModels,
  setListedModels,
  splitVariant,
} from "./providers";

/** Lines from `cursor-agent models` (2026.10.01), labels as the daemon cleans them. */
const LISTED = [
  ["auto", "Auto (default)"],
  ["gpt-5.3-codex-low", "Codex 5.3 Low"],
  ["gpt-5.3-codex", "Codex 5.3"],
  ["gpt-5.3-codex-high", "Codex 5.3 High"],
  ["composer-2.5", "Composer 2.5"],
  ["grok-4.7-low", "Grok 4.7 Low"],
  ["grok-4.7-low-fast", "Grok 4.7 Low Fast"],
  ["grok-4.7-medium", "Grok 4.7 Medium"],
  ["grok-4.7-high", "Grok 4.7 High"],
  ["grok-4.7-high-fast", "Grok 4.7 High Fast"],
  ["grok-4.7-xhigh", "Grok 4.7 Extra High"],
  ["cursor-grok-4.6-medium", "Grok 4.6 Medium"],
  ["cursor-grok-4.6-high", "Grok 4.6"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 1M Low"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 1M"],
  ["claude-opus-5-5-max", "Claude Opus 5.5 1M Max"],
  ["claude-fable-5-1-thinking-high", "Claude Fable 5.1 1M Thinking (NO ZDR)"],
  ["claude-fable-5-1-thinking-xhigh", "Claude Fable 5.1 1M Extra High Thinking (NO ZDR)"],
  ["gpt-5.5-high", "GPT-5.5 1M High"],
  ["gpt-5.5-extra-high", "GPT-5.5 1M Extra High"],
  ["claude-4.6-opus-high-thinking", "Claude Opus 4.6 1M Thinking"],
  ["claude-4.6-opus-max-thinking", "Claude Opus 4.6 1M Max Thinking"],
  ["claude-4.6-sonnet-medium-thinking", "Claude Sonnet 4.6 1M Thinking"],
  ["muse-spark-1.3-minimal", "Muse Spark 1.3 1M Minimal"],
  ["muse-spark-1.3-high", "Muse Spark 1.3 1M"],
].map(([id, label]) => ({ id: id!, label: label! }));

describe("splitVariant", () => {
  it("finds the effort wherever cursor puts it", () => {
    expect(splitVariant("grok-4.7-high-fast")).toEqual({ base: "grok-4.7-fast", effort: "high" });
    expect(splitVariant("claude-opus-5-thinking-xhigh")).toEqual({ base: "claude-opus-5-thinking", effort: "xhigh" });
    expect(splitVariant("claude-4.6-opus-max-thinking")).toEqual({ base: "claude-4.6-opus-thinking", effort: "max" });
    expect(splitVariant("gpt-5.5-extra-high")).toEqual({ base: "gpt-5.5", effort: "xhigh" });
    expect(splitVariant("composer-2.5")).toEqual({ base: "composer-2.5", effort: null });
  });
});

describe("groupListed", () => {
  const models = groupListed(LISTED);
  const byLabel = (label: string) => models.find((m) => m.label === label);

  it("folds a model's efforts into one row, its default the one the label leaves bare", () => {
    expect(byLabel("Grok 4.7")).toEqual({
      // Every one of its labels names an effort: medium, then.
      id: "grok-4.7-medium",
      label: "Grok 4.7",
      variants: { low: "grok-4.7-low", medium: "grok-4.7-medium", high: "grok-4.7-high", xhigh: "grok-4.7-xhigh" },
    });
    expect(byLabel("Grok 4.6")?.id).toBe("cursor-grok-4.6-high");
    expect(byLabel("Claude Opus 5.5 1M")?.id).toBe("claude-opus-5-5-medium");
    expect(byLabel("Claude Fable 5.1 1M Thinking (NO ZDR)")?.variants).toEqual({
      high: "claude-fable-5-1-thinking-high",
      xhigh: "claude-fable-5-1-thinking-xhigh",
    });
  });

  it("keeps fast variants a model of their own", () => {
    expect(byLabel("Grok 4.7 Fast")?.variants).toEqual({ low: "grok-4.7-low-fast", high: "grok-4.7-high-fast" });
  });

  it("reads an id with no effort beside ones that have one as medium", () => {
    expect(byLabel("Codex 5.3")).toEqual({
      id: "gpt-5.3-codex",
      label: "Codex 5.3",
      variants: { low: "gpt-5.3-codex-low", medium: "gpt-5.3-codex", high: "gpt-5.3-codex-high" },
    });
  });

  it("takes the odd spellings: extra-high, an effort before -thinking, minimal", () => {
    expect(byLabel("GPT-5.5 1M")?.variants).toEqual({ high: "gpt-5.5-high", xhigh: "gpt-5.5-extra-high" });
    expect(byLabel("Claude Opus 4.6 1M Thinking")?.variants).toEqual({
      high: "claude-4.6-opus-high-thinking",
      max: "claude-4.6-opus-max-thinking",
    });
    expect(byLabel("Muse Spark 1.3 1M")?.variants).toEqual({ minimal: "muse-spark-1.3-minimal", high: "muse-spark-1.3-high" });
  });

  it("leaves a model with one effort, or none, as it is", () => {
    expect(byLabel("Claude Sonnet 4.6 1M Thinking")).toEqual({ id: "claude-4.6-sonnet-medium-thinking", label: "Claude Sonnet 4.6 1M Thinking" });
    expect(byLabel("Composer 2.5")).toEqual({ id: "composer-2.5", label: "Composer 2.5" });
    expect(models[0]).toEqual({ id: "auto", label: "Auto", note: "Default" });
  });
});

describe("searchModels", () => {
  it("finds a model by label across providers", () => {
    const hits = searchModels(PROVIDERS, "opus");
    expect(hits.some((hit) => hit.provider === "claude" && hit.model.label === "Opus 5.5")).toBe(true);
    expect(hits.some((hit) => hit.provider === "cursor")).toBe(true);
    expect(hits.some((hit) => hit.model.label.includes("Sonnet"))).toBe(false);
  });

  it("finds a model by an id its label does not spell, variants included", () => {
    expect(searchModels(PROVIDERS, "gpt-6-astra")[0]).toMatchObject({ provider: "codex", model: { label: "GPT-6 Astra" } });
    expect(searchModels(PROVIDERS, "grok-4.7-xhigh")[0]).toMatchObject({ provider: "cursor", model: { label: "Grok 4.7" } });
  });

  it("matches nothing for a blank query", () => {
    expect(searchModels(PROVIDERS, "   ")).toEqual([]);
  });
});

describe("a provider whose CLI lists its models", () => {
  setListedModels("cursor", LISTED);

  it("offers what the CLI listed, Grok 4.7 included", () => {
    expect(modelsOf("cursor").some((m) => m.label === "Grok 4.7")).toBe(true);
    expect(findModel("cursor", "grok-4.7-xhigh")?.id).toBe("grok-4.7-medium");
    expect(modelLabel("cursor", "grok-4.7-xhigh")).toBe("Grok 4.7");
    expect(effortsOf("cursor", "grok-4.7-high")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("reads the effort from the id, and picks the id from the effort", () => {
    const base = { provider: "cursor", effort: "", access: "full" } as const;
    expect(fitChoice({ ...base, model: "grok-4.7-xhigh" })).toMatchObject({ model: "grok-4.7-xhigh", effort: "xhigh" });
    expect(fitChoice({ ...base, model: "grok-4.7-xhigh", effort: "low" })).toMatchObject({ model: "grok-4.7-low", effort: "low" });
    // Another model keeps the effort when it has it, else takes its own default.
    expect(fitChoice({ ...base, model: "claude-opus-5-5-medium", effort: "max" })).toMatchObject({ model: "claude-opus-5-5-max", effort: "max" });
    expect(fitChoice({ ...base, model: "cursor-grok-4.6-high", effort: "max" })).toMatchObject({ model: "cursor-grok-4.6-high", effort: "high" });
  });

  it("leaves a model without efforts without one", () => {
    expect(fitChoice({ provider: "cursor", model: "composer-2.5", effort: "high", access: "full" })).toMatchObject({ model: "composer-2.5", effort: "" });
  });

  it("does not touch providers that list nothing", () => {
    expect(fitChoice({ provider: "claude", model: "claude-opus-5-5", effort: "", access: "full" }).effort).toBe("high");
  });
});

describe("choiceForNewSession", () => {
  const defaults = { provider: "claude" as const, model: "claude-opus-5-5", effort: "high" as const, access: "full" as const };

  it("leaves a cursor session unnamed so the daemon reads the CLI's selection", () => {
    expect(choiceForNewSession("cursor", defaults)).toMatchObject({ provider: "cursor", model: "", effort: "", access: "full" });
  });

  it("keeps a cursor model that was picked, Auto included", () => {
    expect(choiceForNewSession({ provider: "cursor", model: "auto", effort: "", access: "full" }, defaults).model).toBe("auto");
    expect(choiceForNewSession({ provider: "cursor", model: "grok-4.7-xhigh", effort: "", access: "full" }, defaults)).toMatchObject({
      model: "grok-4.7-xhigh",
      effort: "xhigh",
    });
  });

  it("leaves codex and opencode unnamed so the daemon reads the CLI", () => {
    expect(choiceForNewSession("codex", defaults)).toMatchObject({ provider: "codex", model: "", effort: "", access: "full" });
    expect(choiceForNewSession("opencode", defaults)).toMatchObject({ provider: "opencode", model: "", effort: "", access: "full" });
  });

  it("keeps a codex model that was picked", () => {
    expect(choiceForNewSession({ provider: "codex", model: "gpt-5.5", effort: "low", access: "ask" }, defaults)).toMatchObject({
      model: "gpt-5.5",
      effort: "low",
      access: "ask",
    });
  });

  it("still names claude's own default", () => {
    expect(choiceForNewSession("claude", defaults)).toMatchObject({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
  });
});
