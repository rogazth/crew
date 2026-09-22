/** Provider + model registry. Adding a provider is a row here, never an `if`. */
export type ProviderId = "claude" | "cursor" | "codex" | "opencode";

export type Model = { id: string; label: string; note?: string };

/**
 * How a terminal session learns its provider's session id: Crew hands Claude
 * its own; cursor-agent creates one before launch; codex and opencode name it
 * themselves once the first message is sent.
 */
export type SessionBinding = "own" | "before" | "after";

export type ProviderDef = {
  id: ProviderId;
  /** Short mark used in labels: "Claude Opus 5", not "Claude Code Opus 5". */
  label: string;
  binary: string;
  modelFlag: string;
  binding: SessionBinding;
  resumeArgs: (id: string) => string[];
  models: Model[];
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude",
    binary: "claude",
    modelFlag: "--model",
    binding: "own",
    resumeArgs: (id) => ["--resume", id],
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1", note: "Toughest" },
      { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
      { id: "claude-opus-5", label: "Opus 5" },
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
    modelFlag: "--model",
    binding: "before",
    resumeArgs: (id) => ["--resume", id],
    models: [
      { id: "auto", label: "Auto", note: "Default" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "cursor-grok-4.6-high", label: "Grok 4.6" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "claude-fable-5-1-thinking-high", label: "Fable 5.1" },
      { id: "claude-opus-5-5-high", label: "Opus 5.5" },
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
    modelFlag: "-m",
    binding: "after",
    resumeArgs: (id) => ["resume", id],
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra", note: "Most capable" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
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
    modelFlag: "-m",
    binding: "after",
    resumeArgs: (id) => ["--session", id],
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
/** No `--model`: the CLI runs whatever the user configured it to. */
export const DEFAULT_MODEL = "";

const CLI_DEFAULT: Model = { id: DEFAULT_MODEL, label: "Default", note: "The CLI's own setting" };

export type AgentChoice = { provider: ProviderId; model: string };

export const providerOf = (id: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export function modelsOf(providerId: string): Model[] {
  const provider = providerOf(providerId);
  return provider ? [CLI_DEFAULT, ...provider.models] : [];
}

export function modelLabel(providerId: string, modelId: string): string {
  return modelsOf(providerId).find((m) => m.id === modelId)?.label ?? modelId;
}

/** The preferred provider when its CLI is installed, else the first one that is. */
export function pickProvider(preferred: AgentChoice, installed: ProviderDef[]): AgentChoice {
  if (installed.some((p) => p.id === preferred.provider)) return preferred;
  const fallback = PROVIDERS.find((p) => installed.includes(p));
  return fallback ? { provider: fallback.id, model: DEFAULT_MODEL } : preferred;
}

/** "Claude Opus 5" — the top line of a sidebar row. */
export function providerLine(providerId: string, modelId: string): string {
  const label = providerOf(providerId)?.label ?? providerId;
  return modelId ? `${label} ${modelLabel(providerId, modelId)}` : label;
}

export function parseAgentChoice(raw: string | null): AgentChoice | null {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (typeof value !== "object" || value === null) return null;
    const { provider, model } = value as Record<string, unknown>;
    if (typeof provider !== "string" || !providerOf(provider)) return null;
    return { provider: provider as ProviderId, model: typeof model === "string" ? model : DEFAULT_MODEL };
  } catch {
    return null;
  }
}
