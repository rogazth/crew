/** Provider + model registry. Adding a provider is a row here, never an `if`. */
export type ProviderId = "claude" | "cursor" | "codex";

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
      { id: "claude-opus-5", label: "Opus 5", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced" },
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Fastest" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    binary: "cursor-agent",
    models: [
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "composer-1", label: "Composer 1" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    models: [
      { id: "gpt-5.6-codex", label: "GPT-5.6 Codex" },
      { id: "gpt-5.6", label: "GPT-5.6" },
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
