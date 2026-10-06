import type { ListedModel } from "./protocol";

/** Provider + model registry. Adding a provider is a row here, never an `if`. */
export type ProviderId = "claude" | "cursor" | "codex" | "opencode";

/** How hard the model thinks, least to most. `none` and `minimal` are only some cursor models'. */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What a session may do without asking, least to most. */
export type Access = "ask" | "edits" | "auto" | "full";

export type Model = {
  id: string;
  label: string;
  note?: string;
  /** Where its effort stops short of the provider's: Opus 4.5 has no max. */
  efforts?: Effort[];
  /**
   * The id each effort runs, where the effort is part of the id: cursor's
   * `grok-4.7-low` … `grok-4.7-xhigh` are one model. `id` is the one the CLI
   * runs when nothing is said.
   */
  variants?: Partial<Record<Effort, string>>;
};

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
  /**
   * The flags each access starts the CLI in. A mode the CLI has no flag for is
   * left out, and is not offered for it. Claude's "ask" is said out loud: the
   * user's own `defaultMode` would otherwise decide where it starts.
   */
  access: Partial<Record<Access, string[]>>;
  /** The efforts its CLI takes, and the flags that set one. None: it has no such knob. */
  efforts: Effort[];
  effortArgs: (effort: Effort) => string[];
  /** The first message, handed to the interactive CLI as it starts. After `--`, so it is never read as a flag or a subcommand. */
  promptArgs: (text: string) => string[];
  /** Crew reads the CLI's own history, so its sessions can open in the chat. */
  chat: boolean;
  models: Model[];
  /** Its CLI lists the account's models (`agent_models`), which replace `models` once read. */
  listsModels?: boolean;
  /**
   * What a session runs when nothing was picked. Crew always names a model and
   * an effort, so the chips say what the CLI runs. Mirrors `default_model` and
   * `default_effort` in `crates/crew-core/src/tools.rs`.
   */
  defaultModel: string;
  defaultEffort?: Effort;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude",
    binary: "claude",
    modelFlag: "--model",
    binding: "own",
    resumeArgs: (id) => ["--resume", id],
    access: {
      ask: ["--permission-mode", "default"],
      edits: ["--permission-mode", "acceptEdits"],
      auto: ["--permission-mode", "auto"],
      full: ["--dangerously-skip-permissions"],
    },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortArgs: (effort) => ["--effort", effort],
    promptArgs: (text) => ["--", text],
    chat: true,
    defaultModel: "claude-opus-5-5",
    defaultEffort: "high",
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1", note: "Toughest" },
      { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced" },
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-opus-4-6", label: "Opus 4.6" },
      { id: "claude-opus-4-5", label: "Opus 4.5", efforts: ["low", "medium", "high"] },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    binary: "cursor-agent",
    modelFlag: "--model",
    binding: "before",
    resumeArgs: (id) => ["--resume", id],
    access: { ask: [], auto: ["--auto-review"], full: ["--force"] },
    // Its model ids carry their effort, `grok-4.7-high`: each model's
    // `variants`, read from `cursor-agent models` (`loadListedModels`).
    efforts: [],
    effortArgs: () => [],
    promptArgs: (text) => ["--", text],
    chat: true,
    listsModels: true,
    defaultModel: "auto",
    models: [
      { id: "auto", label: "Auto", note: "Default" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "grok-4.7-high", label: "Grok 4.7" },
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
    access: { ask: [], auto: ["--approve-for-me"], full: ["--dangerously-bypass-approvals-and-sandbox"] },
    efforts: ["low", "medium", "high", "xhigh"],
    effortArgs: (effort) => ["-c", `model_reasoning_effort="${effort}"`],
    promptArgs: (text) => ["--", text],
    chat: true,
    defaultModel: "gpt-6-astra",
    defaultEffort: "medium",
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
    access: { ask: [], full: ["--auto"] },
    efforts: [],
    effortArgs: () => [],
    // Its one positional is the project folder.
    promptArgs: (text) => [`--prompt=${text}`],
    chat: true,
    defaultModel: "opencode/ling-3.0-flash-fin-free",
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
/** What a new session starts with: who runs it, on what, how hard and how freely. */
export type AgentChoice = { provider: ProviderId; model: string; effort: Effort | ""; access: Access };

/** A fresh install runs without asking; the composer says so, and one click asks. */
export const DEFAULT_ACCESS: Access = "full";

export const ACCESSES: { id: Access; label: string; description: string }[] = [
  { id: "ask", label: "Ask permission", description: "Asks before every edit and command." },
  { id: "edits", label: "Accept edits", description: "Edits files on its own, asks before commands." },
  { id: "auto", label: "Auto", description: "Runs routine actions, asks only for risky ones." },
  { id: "full", label: "Full access", description: "Edits and runs anything without asking." },
];

export const EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const providerOf = (id: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export function modelsOf(providerId: string): Model[] {
  return listed.get(providerId) ?? providerOf(providerId)?.models ?? [];
}

/** The model an id runs, any of its effort variants included. */
export function findModel(providerId: string, modelId: string): Model | undefined {
  const models = modelsOf(providerId);
  return (
    models.find((m) => m.id === modelId) ??
    models.find((m) => m.variants && Object.values(m.variants).includes(modelId))
  );
}

/** The model a session of this provider runs when none was picked. */
export function defaultModelOf(providerId: string): string {
  return providerOf(providerId)?.defaultModel ?? "";
}

/** The effort a model thinks at when none was picked: its provider's, else the most it takes. */
export function defaultEffortOf(providerId: string, modelId: string): Effort | "" {
  const efforts = effortsOf(providerId, modelId);
  const preferred = providerOf(providerId)?.defaultEffort;
  if (preferred && efforts.includes(preferred)) return preferred;
  return efforts.at(-1) ?? "";
}

export function modelLabel(providerId: string, modelId: string): string {
  return findModel(providerId, modelId)?.label ?? modelId;
}

/** The efforts a model takes: its own, else its provider's. */
export function effortsOf(providerId: string, modelId: string): Effort[] {
  const provider = providerOf(providerId);
  if (!provider) return [];
  const model = findModel(providerId, modelId);
  if (model?.variants) return EFFORTS.filter((effort) => model.variants?.[effort]);
  return model?.efforts ?? provider.efforts;
}

/** The accesses a provider's CLI can start in, least to most. */
export function accessesOf(providerId: string): Access[] {
  const provider = providerOf(providerId);
  return ACCESSES.map((a) => a.id).filter((id) => provider?.access[id] !== undefined);
}

export const accessLabel = (access: string): string => ACCESSES.find((a) => a.id === access)?.label ?? access;

/**
 * A choice carried to another provider or model keeps what still fits: no
 * model takes the provider's default, an effort it does not take goes to the
 * model's default, an access it has no mode for asks.
 */
export function fitChoice(choice: AgentChoice): AgentChoice {
  const model = choice.model || defaultModelOf(choice.provider);
  const access = accessesOf(choice.provider).includes(choice.access) ? choice.access : "ask";
  const variants = findModel(choice.provider, model)?.variants;
  if (variants) {
    // The effort is in the id: a picked effort picks the id, else the id says it.
    const effort =
      choice.effort && variants[choice.effort]
        ? choice.effort
        : (EFFORTS.find((e) => variants[e] === model) ?? EFFORTS.find((e) => variants[e]) ?? "");
    return { ...choice, model: (effort && variants[effort]) || model, effort, access };
  }
  const effort =
    choice.effort && effortsOf(choice.provider, model).includes(choice.effort) ? choice.effort : defaultEffortOf(choice.provider, model);
  return { ...choice, model, effort, access };
}

/** The preferred provider when its CLI is installed, else the first one that is. */
export function pickProvider(preferred: AgentChoice, installed: ProviderDef[]): AgentChoice {
  if (installed.some((p) => p.id === preferred.provider)) return preferred;
  const fallback = PROVIDERS.find((p) => installed.includes(p));
  return fallback ? fitChoice({ ...preferred, provider: fallback.id, model: "" }) : preferred;
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
    const { provider, model, effort, access } = value as Record<string, unknown>;
    if (typeof provider !== "string" || !providerOf(provider)) return null;
    return fitChoice({
      provider: provider as ProviderId,
      model: typeof model === "string" ? model : "",
      effort: typeof effort === "string" && effort in EFFORT_LABELS ? (effort as Effort) : "",
      access: ACCESSES.some((a) => a.id === access) ? (access as Access) : DEFAULT_ACCESS,
    });
  } catch {
    return null;
  }
}

/** Every effort, least to most: the order a model's are offered in. */
const EFFORTS = Object.keys(EFFORT_LABELS) as Effort[];

/** How cursor-agent spells each effort in an id and in a label, longest first. */
const EFFORT_SPELLINGS: [suffix: string, effort: Effort, word: string][] = [
  ["extra-high", "xhigh", "Extra High"],
  ["xhigh", "xhigh", "Extra High"],
  ["minimal", "minimal", "Minimal"],
  ["medium", "medium", "Medium"],
  ["none", "none", "None"],
  ["high", "high", "High"],
  ["low", "low", "Low"],
  ["max", "max", "Max"],
];

/**
 * The model an id is a variant of, and at what effort: `grok-4.7-high-fast`
 * is `grok-4.7-fast` at high; `claude-4.6-opus-max-thinking` is
 * `claude-4.6-opus-thinking` at max. An id with no effort in it is its own.
 */
export function splitVariant(id: string): { base: string; effort: Effort | null } {
  const fast = id.endsWith("-fast") ? "-fast" : "";
  const rest = fast ? id.slice(0, -fast.length) : id;
  for (const [suffix, effort] of EFFORT_SPELLINGS) {
    if (rest.endsWith(`-${suffix}`)) return { base: rest.slice(0, -suffix.length - 1) + fast, effort };
    if (rest.endsWith(`-${suffix}-thinking`)) {
      return { base: rest.slice(0, -suffix.length - "--thinking".length) + "-thinking" + fast, effort };
    }
  }
  return { base: id, effort: null };
}

const wordIn = (label: string, word: string) => new RegExp(`(^|\\s)${word}(?=\\s|$)`).test(label);

/**
 * `cursor-agent models` folded into one model per base, its efforts as
 * `variants`, in the order the CLI lists them. The variant the CLI runs by
 * default is the one whose label leaves the effort out ("Claude Opus 5.5 1M"
 * is medium); an id with no effort in it, beside ones that have one, is medium.
 */
export function groupListed(rows: ListedModel[]): Model[] {
  const groups = new Map<string, { effort: Effort | null; id: string; label: string }[]>();
  for (const row of rows) {
    const { base, effort } = splitVariant(row.id);
    const group = groups.get(base) ?? [];
    group.push({ effort, id: row.id, label: row.label });
    groups.set(base, group);
  }
  const models: Model[] = [];
  for (const [base, group] of groups) {
    const efforts = group.filter((v) => v.effort);
    const bare = group.find((v) => !v.effort);
    if (bare && efforts.length > 0 && !efforts.some((v) => v.effort === "medium")) {
      bare.effort = "medium";
      efforts.push(bare);
    } else if (bare) {
      models.push(plain(bare.id, bare.label));
    }
    if (efforts.length === 0) continue;
    if (efforts.length === 1) {
      const only = efforts[0]!;
      models.push(plain(only.id, only.label));
      continue;
    }
    const word = (effort: Effort) => EFFORT_SPELLINGS.find(([, e]) => e === effort)![2];
    const fallback = efforts.find((v) => v.effort === "medium") ?? efforts[0]!;
    const main = efforts.find((v) => !wordIn(v.label, word(v.effort!))) ?? fallback;
    const label = main.label.replace(new RegExp(`\\s${word(main.effort!)}(?=\\s|$)`), "");
    const variants: Partial<Record<Effort, string>> = {};
    for (const v of efforts) variants[v.effort!] ??= v.id;
    models.push({ id: main.id, label: label || base, variants });
  }
  return models;
}

/** "Auto (default)" reads as the model plus a note, the way Crew's own list says it. */
function plain(id: string, label: string): Model {
  const defaulted = label.endsWith(" (default)");
  return defaulted ? { id, label: label.slice(0, -" (default)".length), note: "Default" } : { id, label };
}

/** What each provider's CLI listed, in place of its row's `models` once read. */
const listed = new Map<string, Model[]>();
const listeners = new Set<() => void>();
let listedVersion = 0;
const asked = new Map<string, number>();
/** Asked again at most this often: the CLI takes about a second to answer. */
const LIST_AGAIN_MS = 5 * 60_000;

export function subscribeListedModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const listedModelsVersion = () => listedVersion;

/** Replaces a provider's models with what its CLI listed; nothing listed keeps Crew's own. */
export function setListedModels(providerId: string, rows: ListedModel[]): void {
  const models = groupListed(rows);
  if (models.length === 0) return;
  listed.set(providerId, models);
  listedVersion += 1;
  for (const listener of listeners) listener();
}

/** Asks the provider's CLI for its models, unless it was asked a moment ago. */
export function loadListedModels(providerId: string, fetch: (provider: string) => Promise<ListedModel[]>): void {
  if (!providerOf(providerId)?.listsModels) return;
  const last = asked.get(providerId);
  if (last !== undefined && Date.now() - last < LIST_AGAIN_MS) return;
  asked.set(providerId, Date.now());
  fetch(providerId)
    .then((rows) => setListedModels(providerId, rows))
    .catch(() => asked.delete(providerId));
}
