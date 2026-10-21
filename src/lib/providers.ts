import { fuzzyMatch } from "./fuzzy";
import type { ListedModel } from "./protocol";

/** Provider + model registry. Adding a provider is a row here, never an `if`. */
export type ProviderId = "claude" | "cursor" | "codex" | "opencode" | "grok";

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
  /** The effort this model runs when none was picked. From the provider's listing. */
  defaultEffort?: Effort;
  /** The fast id for each effort that has one: `grok-4.7-high-fast` beside `grok-4.7-high`. */
  fastVariants?: Partial<Record<Effort, string>>;
  /** The fast id of a model whose effort is not part of the id: `composer-2.5-fast`. */
  fastId?: string;
  /**
   * Codex service tiers besides Standard. Absent until the catalog is read;
   * empty when the model advertises none.
   */
  tiers?: { id: string; label: string }[];
};

export type ProviderDef = {
  id: ProviderId;
  /** Short mark used in labels: "Claude Opus 5", not "Claude Code Opus 5". */
  label: string;
  binary: string;
  /**
   * The flags each access runs the CLI in, which is what says the CLI has the
   * mode: one it has no flag for is left out, and is not offered for it.
   */
  access: Partial<Record<Access, string[]>>;
  /** The efforts its CLI takes. None: it has no such knob. */
  efforts: Effort[];
  models: Model[];
  /** Its CLI lists the account's models (`agent_models`), which replace `models` once read. */
  listsModels?: boolean;
  /**
   * What a session runs when nothing was picked and the CLI's own selection
   * cannot be read. Mirrors `default_model` and `default_effort` in
   * `crates/crew-core/src/tools.rs`.
   */
  defaultModel: string;
  defaultEffort?: Effort;
  /**
   * A new session that names no model stays blank, and the daemon reads the
   * CLI. Naming a model keeps it.
   */
  cliModel?: boolean;
  /**
   * An effort nobody picked stays unset, so the CLI's own default is not
   * cleared. Settings offers that as "CLI default".
   */
  cliEffort?: boolean;
  /**
   * The sign-in to type on a remote machine, where a browser login has
   * nowhere to finish. Absent, the daemon's login command is used everywhere.
   */
  remoteLogin?: string;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    label: "Claude",
    binary: "claude",
    access: {
      ask: ["--permission-mode", "default"],
      edits: ["--permission-mode", "acceptEdits"],
      auto: ["--permission-mode", "auto"],
      full: ["--dangerously-skip-permissions"],
    },
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultModel: "claude-opus-5-5",
    defaultEffort: "high",
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1", note: "Toughest" },
      { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Balanced" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "Fastest" },
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
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
    access: { ask: [], auto: ["--auto-review"], full: ["--force"] },
    // Its model ids carry their effort, `grok-4.7-high`: each model's
    // `variants`, read from `cursor-agent models` (`loadListedModels`).
    efforts: [],
    listsModels: true,
    cliModel: true,
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
    access: { ask: [], auto: ["--approve-for-me"], full: ["--dangerously-bypass-approvals-and-sandbox"] },
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    listsModels: true,
    cliModel: true,
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
    access: { ask: [], full: ["--auto"] },
    efforts: [],
    // Its one positional is the project folder.
    cliModel: true,
    defaultModel: "opencode/ling-3.0-flash-fin-free",
    models: [
      { id: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash", note: "Free" },
      { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning", note: "Free" },
      { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra", note: "Free" },
      { id: "opencode/mimo-v2.5-free", label: "MiMo v2.5", note: "Free" },
      { id: "opencode/muse-spark-1.3-contributor-free", label: "Muse Spark 1.3", note: "Free" },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    binary: "grok",
    access: {
      // Edits has no agent mode: the launch is ask, and the client approves edits.
      // Full is `--always-approve` on `agent`, not the TUI's bypassPermissions.
      ask: ["--permission-mode", "default"],
      edits: ["--permission-mode", "default"],
      auto: ["--permission-mode", "auto"],
      full: ["--always-approve"],
    },
    // Each model's efforts come from the CLI's listing (`loadListedModels`).
    efforts: [],
    listsModels: true,
    cliModel: true,
    cliEffort: true,
    remoteLogin: "grok login --device-auth",
    defaultModel: "",
    models: [],
  },
];

export const DEFAULT_PROVIDER: ProviderId = "claude";
/** What a new session starts with: who runs it, on what, how hard and how freely. */
export type AgentChoice = {
  provider: ProviderId;
  model: string;
  effort: Effort | "";
  access: Access;
  /** Codex's service tier. Empty is the CLI's own; `default` is Standard. */
  serviceTier?: string;
};

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

export type ModelMatch = { provider: ProviderId; model: Model };

/** Models across these providers that match the query, best first. A blank query matches nothing. */
export function searchModels(providers: readonly ProviderDef[], query: string): ModelMatch[] {
  if (!query.trim()) return [];
  const scored: { match: ModelMatch; score: number }[] = [];
  for (const provider of providers) {
    for (const model of modelsOf(provider.id)) {
      const variants = model.variants ? Object.values(model.variants).join(" ") : "";
      const fast = [model.fastId, ...(model.fastVariants ? Object.values(model.fastVariants) : [])].filter(Boolean).join(" ");
      const text = `${provider.label} ${model.label} ${model.id} ${variants} ${fast} ${model.note ?? ""}`;
      const hit = fuzzyMatch(query, text);
      // fuzzyMatch charges for length, which would rank a model below an older
      // one for a longer id or a note; only how well the query fits counts here.
      if (hit) scored.push({ match: { provider: provider.id, model }, score: hit.score + text.length });
    }
  }
  // Equal matches of one family (Grok 4.5, Grok 4.7) go newest first: cursor's
  // CLI lists its models in no such order. Families keep the order they came in.
  const firstSeen = new Map<string, number>();
  const keyed = scored.map((entry, index) => {
    const { family, version } = versionOf(entry.match.model.label);
    const familyKey = `${entry.match.provider} ${family}`;
    if (!firstSeen.has(familyKey)) firstSeen.set(familyKey, index);
    return { ...entry, family: firstSeen.get(familyKey)!, version };
  });
  keyed.sort((a, b) => b.score - a.score || a.family - b.family || compareVersions(b.version, a.version));
  return keyed.map((entry) => entry.match);
}

/** "Grok 4.7 High" is family "Grok", version [4, 7]; a label without a number is version []. */
function versionOf(label: string): { family: string; version: number[] } {
  const found = /\d+(?:\.\d+)*/.exec(label);
  if (!found) return { family: label, version: [] };
  return { family: label.slice(0, found.index).trim(), version: found[0].split(".").map(Number) };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The model an id runs, any of its effort or fast variants included. */
export function findModel(providerId: string, modelId: string): Model | undefined {
  const models = modelsOf(providerId);
  return (
    models.find((m) => m.id === modelId) ??
    models.find((m) => m.fastId === modelId) ??
    models.find((m) => m.variants && Object.values(m.variants).includes(modelId)) ??
    models.find((m) => m.fastVariants && Object.values(m.fastVariants).includes(modelId))
  );
}

export type ModelTier = { id: string; label: string };

/** Service tiers a model advertises, besides Standard. Empty until it advertises any. */
export function tiersOf(providerId: string, modelId: string): ModelTier[] {
  const id = modelId || defaultModelOf(providerId);
  return findModel(providerId, id)?.tiers ?? [];
}

/** Whether this id is the fast run, and whether the current effort has one. */
export function fastChoice(providerId: string, modelId: string): { on: boolean; available: boolean } {
  const model = findModel(providerId, modelId);
  if (!model) return { on: false, available: false };
  const part = splitVariant(modelId);
  if (part.effort) {
    const fastId = model.fastVariants?.[part.effort];
    return { on: fastId === modelId, available: Boolean(fastId) };
  }
  return { on: model.fastId === modelId, available: Boolean(model.fastId) };
}

/** The id this model runs at when Fast is on or off. An effort with no fast sibling stays put. */
export function setFast(providerId: string, modelId: string, on: boolean): string {
  const model = findModel(providerId, modelId);
  if (!model) return modelId;
  const part = splitVariant(modelId);
  if (part.effort) {
    if (on) return model.fastVariants?.[part.effort] ?? modelId;
    return model.variants?.[part.effort] ?? model.id;
  }
  return on ? (model.fastId ?? modelId) : model.id;
}

/**
 * What `/fast` does to the chips: the same switch the Fast chip makes, or
 * nothing (null) for a model with no fast run to switch to.
 */
export function toggledFast(value: AgentChoice): AgentChoice | null {
  const fitted = fitChoice(value);
  if (fitted.provider === "claude") return fitChoice({ ...fitted, serviceTier: fitted.serviceTier === "fast" ? "" : "fast" });
  const fast = fastChoice(fitted.provider, fitted.model);
  if (fast.available) return fitChoice({ ...fitted, model: setFast(fitted.provider, fitted.model, !fast.on) });
  if (!tiersOf(fitted.provider, fitted.model).some((tier) => tier.id === "fast")) return null;
  return fitChoice({ ...fitted, serviceTier: fitted.serviceTier === "fast" ? "" : "fast" });
}

/** The model a session of this provider runs when none was picked. */
export function defaultModelOf(providerId: string): string {
  return providerOf(providerId)?.defaultModel ?? "";
}

/** The effort a model thinks at when none was picked: its own, else its provider's, else the most it takes. `cliEffort` leaves it unset so the CLI's default stays. */
export function defaultEffortOf(providerId: string, modelId: string): Effort | "" {
  if (providerOf(providerId)?.cliEffort) return "";
  const efforts = effortsOf(providerId, modelId);
  const preferred = findModel(providerId, modelId)?.defaultEffort ?? providerOf(providerId)?.defaultEffort;
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
  const modelId = choice.model || defaultModelOf(choice.provider);
  const access = accessesOf(choice.provider).includes(choice.access) ? choice.access : "ask";
  const found = findModel(choice.provider, modelId);
  const variants = found?.variants;
  let model = modelId;
  let effort: Effort | "";
  if (variants) {
    // The effort is in the id: a picked effort picks the id, else the id says it.
    effort =
      choice.effort && variants[choice.effort]
        ? choice.effort
        : (EFFORTS.find((e) => variants[e] === modelId || found?.fastVariants?.[e] === modelId) ??
          EFFORTS.find((e) => variants[e]) ??
          "");
    const slow = (effort && variants[effort]) || modelId;
    model = keepFast(found, modelId, slow);
  } else {
    effort =
      choice.effort && effortsOf(choice.provider, modelId).includes(choice.effort)
        ? choice.effort
        : defaultEffortOf(choice.provider, modelId);
  }
  return { ...choice, model, effort, access, serviceTier: fitTier(found, choice.serviceTier) };
}

/** A fast id stays fast at the new effort when that effort has a fast sibling. */
function keepFast(model: Model | undefined, previousId: string, nextId: string): string {
  if (!model || (model.fastId !== previousId && !Object.values(model.fastVariants ?? {}).includes(previousId))) return nextId;
  const part = splitVariant(nextId);
  const fastId = part.effort ? model.fastVariants?.[part.effort] : model.fastId;
  if (fastId) return fastId;
  return nextId;
}

/**
 * A tier stays while the catalog has not been read. Once it has, a tier the
 * model does not advertise is dropped; Standard (`default`) always fits.
 */
function fitTier(model: Model | undefined, tier: string | undefined): string {
  if (!tier) return "";
  if (!model || model.tiers === undefined) return tier;
  if (tier === "default" || model.tiers.some((row) => row.id === tier)) return tier;
  return "";
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

/**
 * What a new session is created with. `cliModel` goes out with a blank model
 * when nobody named one, and the daemon reads the CLI. For Grok it then
 * stores the id the provider reports, because a launch that names no model
 * can run a different one. `cliEffort` stays blank either way, so the CLI's
 * own default is not cleared.
 */
export function choiceForNewSession(pick: ProviderId | AgentChoice, defaults: AgentChoice): AgentChoice {
  const specified: AgentChoice =
    typeof pick === "object" ? pick : { ...defaults, provider: pick, model: pick === defaults.provider ? defaults.model : "" };
  const choice = fitChoice(specified);
  if (specified.model === "" && providerOf(choice.provider)?.cliModel) {
    return { ...choice, model: "", effort: "", serviceTier: "" };
  }
  return choice;
}

export function parseAgentChoice(raw: string | null): AgentChoice | null {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (typeof value !== "object" || value === null) return null;
    const { provider, model, effort, access, serviceTier } = value as Record<string, unknown>;
    if (typeof provider !== "string" || !providerOf(provider)) return null;
    return fitChoice({
      provider: provider as ProviderId,
      model: typeof model === "string" ? model : "",
      effort: typeof effort === "string" && effort in EFFORT_LABELS ? (effort as Effort) : "",
      access: ACCESSES.some((a) => a.id === access) ? (access as Access) : DEFAULT_ACCESS,
      serviceTier: typeof serviceTier === "string" ? serviceTier : "",
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
 * is `grok-4.7` at high, fast; `claude-4.6-opus-max-thinking` is
 * `claude-4.6-opus-thinking` at max. An id with no effort in it is its own.
 * The same split `split_variant` does in `provider_session.rs`.
 */
export function splitVariant(id: string): { base: string; effort: Effort | null; fast: boolean } {
  const fast = id.endsWith("-fast");
  const rest = fast ? id.slice(0, -"-fast".length) : id;
  for (const [suffix, effort] of EFFORT_SPELLINGS) {
    if (rest.endsWith(`-${suffix}`)) return { base: rest.slice(0, -suffix.length - 1), effort, fast };
    if (rest.endsWith(`-${suffix}-thinking`)) {
      return { base: rest.slice(0, -suffix.length - "--thinking".length) + "-thinking", effort, fast };
    }
  }
  return { base: rest, effort: null, fast };
}

const wordIn = (label: string, word: string) => new RegExp(`(^|\\s)${word}(?=\\s|$)`).test(label);

type ListedPart = { effort: Effort | null; id: string; label: string; fast: boolean; tiers?: ModelTier[] };

/**
 * A provider's listing folded into one model per base, its efforts as
 * `variants` and its `-fast` ids as `fastVariants`, in the order the CLI
 * lists them. The variant the CLI runs by default is the one whose label
 * leaves the effort out ("Claude Opus 5.5 1M" is medium); an id with no
 * effort in it, beside ones that have one, is medium. A fast id with no
 * slow sibling stays a model of its own.
 */
export function groupListed(rows: ListedModel[]): Model[] {
  const groups = new Map<string, ListedPart[]>();
  for (const row of rows) {
    const { base, effort, fast } = splitVariant(row.id);
    const group = groups.get(base) ?? [];
    const part: ListedPart = { effort, id: row.id, label: row.label, fast };
    if (row.tiers) part.tiers = row.tiers;
    group.push(part);
    groups.set(base, group);
  }
  const models: Model[] = [];
  for (const [base, group] of groups) {
    const slow = group.filter((row) => !row.fast);
    const fast = group.filter((row) => row.fast);
    const before = models.length;
    foldEfforts(base, slow.length > 0 ? slow : fast, models);
    const host = models.at(-1);
    if (!host || models.length === before) continue;
    if (slow.length > 0) attachFast(host, fast);
    if (group.some((row) => row.tiers !== undefined)) {
      host.tiers = dedupeTiers(group.flatMap((row) => row.tiers ?? []));
    }
  }
  applyListedEfforts(models, rows);
  return models;
}

/** Efforts a listing names on the model itself, least to most. Cursor's live in the id. */
function applyListedEfforts(models: Model[], rows: ListedModel[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const model of models) {
    if (model.variants) continue;
    const row = byId.get(model.id);
    if (!row?.efforts?.length) continue;
    const efforts = EFFORTS.filter((effort) => row.efforts!.includes(effort));
    if (efforts.length === 0) continue;
    model.efforts = efforts;
    if (row.defaultEffort && efforts.includes(row.defaultEffort as Effort)) model.defaultEffort = row.defaultEffort as Effort;
  }
}

/** Efforts of one family, the way a listing without a fast split already folded them. */
function foldEfforts(base: string, group: ListedPart[], models: Model[]) {
  const efforts = group.filter((v) => v.effort);
  const bare = group.find((v) => !v.effort);
  if (bare && efforts.length > 0 && !efforts.some((v) => v.effort === "medium")) {
    bare.effort = "medium";
    efforts.push(bare);
  } else if (bare) {
    models.push(plain(bare.id, bare.label));
  }
  if (efforts.length === 0) return;
  if (efforts.length === 1) {
    const only = efforts[0]!;
    models.push(plain(only.id, only.label));
    return;
  }
  const word = (effort: Effort) => EFFORT_SPELLINGS.find(([, e]) => e === effort)![2];
  const fallback = efforts.find((v) => v.effort === "medium") ?? efforts[0]!;
  const main = efforts.find((v) => !wordIn(v.label, word(v.effort!))) ?? fallback;
  const label = main.label.replace(new RegExp(`\\s${word(main.effort!)}(?=\\s|$)`), "");
  const variants: Partial<Record<Effort, string>> = {};
  for (const v of efforts) variants[v.effort!] ??= v.id;
  models.push({ id: main.id, label: label || base, variants });
}

/** Fast rows join the slow model: one id per effort that has a sibling, or one id when the model has no efforts. */
function attachFast(model: Model, rows: ListedPart[]) {
  if (rows.length === 0) return;
  if (model.variants) {
    const variants: Partial<Record<Effort, string>> = {};
    for (const row of rows) {
      if (row.effort && model.variants[row.effort]) variants[row.effort] = row.id;
    }
    if (Object.keys(variants).length > 0) model.fastVariants = variants;
    return;
  }
  const slow = splitVariant(model.id);
  const match = rows.find((row) => row.effort === slow.effort);
  if (match) model.fastId = match.id;
}

function dedupeTiers(rows: ModelTier[]): ModelTier[] {
  const seen = new Set<string>();
  const tiers: ModelTier[] = [];
  for (const row of rows) {
    if (!row.id || row.id === "default" || seen.has(row.id)) continue;
    seen.add(row.id);
    tiers.push(row);
  }
  return tiers;
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
