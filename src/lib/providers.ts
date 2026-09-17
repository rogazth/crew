/** Provider + model registry. Adding a provider is a row here, never an `if`. */
export type ProviderId = "claude" | "cursor" | "codex" | "opencode";

export type Model = { id: string; label: string; note?: string };

export type ProviderDef = {
  id: ProviderId;
  /** Short mark used in labels: "Claude Opus 5", not "Claude Code Opus 5". */
  label: string;
  binary: string;
  models: Model[];
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude",
    binary: "claude",
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1", note: "Toughest" },
      { id: "claude-opus-5", label: "Opus 5", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced" },
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-opus-4-6", label: "Opus 4.6" },
      { id: "claude-opus-4-5", label: "Opus 4.5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    binary: "cursor-agent",
    models: [
      { id: "auto", label: "Auto", note: "Default" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "cursor-grok-4.6-high", label: "Grok 4.6" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "claude-fable-5-1-thinking-high", label: "Fable 5.1" },
      { id: "claude-opus-5-thinking-high", label: "Opus 5" },
      { id: "claude-sonnet-5-thinking-high", label: "Sonnet 5" },
      { id: "gpt-5.6-sol-medium", label: "GPT-5.6 Sol" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash" },
      { id: "cursor-grok-4.5-high", label: "Grok 4.5" },
      { id: "claude-opus-4-8-thinking-high", label: "Opus 4.8" },
      { id: "claude-4.6-opus-high-thinking", label: "Opus 4.6" },
      { id: "claude-4.6-sonnet-medium-thinking", label: "Sonnet 4.6" },
      { id: "gpt-5.5-medium", label: "GPT-5.5" },
      { id: "gpt-5.4-medium", label: "GPT-5.4" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", note: "Most capable" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Workhorse" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Balanced" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "Fast" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
  },
  {
    id: "opencode",
    label: "opencode",
    binary: "opencode",
    /** opencode's own models, which answer without any login. */
    models: [
      { id: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash", note: "Free" },
      { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning", note: "Free" },
      { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra", note: "Free" },
      { id: "opencode/mimo-v2.5-free", label: "MiMo v2.5", note: "Free" },
      { id: "opencode/muse-spark-1.3-contributor-free", label: "Muse Spark 1.3", note: "Free" },
    ],
  },
];

export const DEFAULT_PROVIDER: ProviderId = "claude";
export const DEFAULT_MODEL = "claude-opus-5";

export const providerOf = (id: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export function modelsOf(providerId: string): Model[] {
  return providerOf(providerId)?.models ?? [];
}

export function modelLabel(providerId: string, modelId: string): string {
  return modelsOf(providerId).find((m) => m.id === modelId)?.label ?? modelId;
}

/** "Claude Opus 5" — the top line of a sidebar row. */
export function providerLine(providerId: string, modelId: string): string {
  const label = providerOf(providerId)?.label ?? providerId;
  return modelId ? `${label} ${modelLabel(providerId, modelId)}` : label;
}
