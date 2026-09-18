export type ProviderId = "claude" | "cursor" | "codex" | "opencode";

export type Model = { id: string; label: string; note?: string };

export type ProviderDef = {
  id: ProviderId;
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
      { id: "claude-opus-5", label: "Opus 5", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-6", label: "Opus 4.6" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "Fast" },
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
      { id: "claude-opus-5-thinking-high", label: "Opus 5" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash" },
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
    ],
  },
  {
    id: "opencode",
    label: "opencode",
    binary: "opencode",
    models: [
      { id: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash", note: "Free" },
      { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra", note: "Free" },
      { id: "opencode/mimo-v2.5-free", label: "MiMo v2.5", note: "Free" },
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

/** "Claude Opus 5" — the second line of a sidebar row. */
export function providerLine(providerId: string, modelId: string): string {
  const label = providerOf(providerId)?.label ?? providerId;
  return modelId ? `${label} ${modelLabel(providerId, modelId)}` : label;
}
