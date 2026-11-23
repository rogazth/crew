import { wordsMatch, searchAgents } from "./agentMentions";
import { launcherAddress, launcherPages } from "./browser/launch";
import { inlineCompletion } from "./browser/suggest";
import { searchUrl } from "./browser/url";
import { SEARCH_ENGINES } from "./browserPrefs";
import { fitChoice, providerOf, searchModels, type AgentChoice, type ProviderDef, type ProviderId } from "./providers";
import type { Session } from "./types";

/**
 * What the blank tab ⌘T opens offers. With nothing typed, the kinds of tab it
 * can become. Typed, what the words name (a kind, an agent, a model, a session
 * or a bot) and what to do with the words themselves (open them as a page,
 * search for them), then pages from history. It starts things; it never talks
 * to an agent or runs a command.
 */

export type Kind = "session" | "browser" | "terminal" | "bot" | "incognito";

/** What each kind is called, which is also what typing finds it by. */
export const KIND_TITLES: Record<Kind, string> = {
  session: "Session",
  browser: "Browser",
  terminal: "Terminal",
  bot: "Bot",
  incognito: "Incognito",
};

/** The Session row with no agent CLI installed: what Enter does then. */
export const SETUP_TITLE = "Set up an agent";

const KINDS: Kind[] = ["session", "browser", "terminal", "bot", "incognito"];

export type BlankRow =
  | { id: string; kind: "new"; what: Kind }
  /** No agent CLI installed: Settings, where one is set up. */
  | { id: "setup"; kind: "setup" }
  /** A new session with this pick, found by its provider's name or its model's. */
  | { id: string; kind: "agent"; choice: AgentChoice; by: "provider" | "model" }
  /** A session or bot that already exists. */
  | { id: string; kind: "existing"; session: Session }
  | { id: "open"; kind: "open"; url: string; title: string; detail: string }
  | { id: "search"; kind: "search"; url: string; engine: string }
  | { id: string; kind: "page"; url: string; title: string; detail: string };

export type BlankContext = {
  /** The agent CLIs on this machine; none, and the Session row sets one up. */
  installed: readonly ProviderDef[];
  /** What a new session of `provider` starts with. */
  choiceOf: (provider: ProviderId) => AgentChoice;
  /** The workspace's sessions and bots, the never-used ones already left out. */
  agents: readonly Session[];
  /** The browser's history for what is typed, in the daemon's order; it may still answer an earlier text. */
  history: readonly { url: string; urlKey: string; title: string }[];
  searchTemplate: string;
};

const MODELS_FROM = 3;

export function blankRows(input: string, ctx: BlankContext): BlankRow[] {
  const typed = input.trim();
  const kinds = KINDS.map((what): BlankRow =>
    what === "session" && ctx.installed.length === 0 ? { id: "setup", kind: "setup" } : { id: `new:${what}`, kind: "new", what },
  );
  if (!typed) return kinds;

  // What the words name.
  const named: BlankRow[] = kinds.filter((row) => matches(typed, rowName(row)));
  for (const provider of ctx.installed.filter((p) => matches(typed, p.label)).slice(0, 2)) {
    named.push({ id: `provider:${provider.id}`, kind: "agent", choice: ctx.choiceOf(provider.id), by: "provider" });
  }
  // A model only when nothing else answered (`cod` is Codex, not every model with Code in its name), ranked
  // as the model picker ranks it: `grok 4.7` is Grok's own before Cursor's.
  if (named.length === 0 && typed.length >= MODELS_FROM) {
    const models = searchModels(ctx.installed, typed).filter(
      ({ provider, model }) => matches(typed, model.label) || matches(typed, `${providerOf(provider)?.label ?? provider} ${model.label}`),
    );
    for (const { provider, model } of models.slice(0, 2)) {
      const choice = fitChoice({ ...ctx.choiceOf(provider), provider, model: model.id });
      named.push({ id: `model:${provider}:${model.id}`, kind: "agent", choice, by: "model" });
    }
  }
  const existing = searchAgents(
    typed,
    ctx.agents.filter((session) => session.kind !== "child"),
    3,
  ).map((session): BlankRow => ({ id: `existing:${session.id}`, kind: "existing", session }));

  // What to do with the words: a visited address they start (`localhost:30` is `localhost:3001`), else the
  // address they are, then a search for them even when they read as an address.
  const completion = inlineCompletion(typed, ctx.history);
  const address = launcherAddress(typed, false);
  const target = completion ? { url: completion.url, label: typed + completion.suffix } : address;
  const actions: BlankRow[] = [
    ...(target ? [openRow(target.url, target.label)] : []),
    { id: "search", kind: "search", url: searchUrl(typed, ctx.searchTemplate), engine: engineName(ctx.searchTemplate) },
  ];

  // A name leads (`plan` is the Planner bot), unless the words are plainly an address.
  const certain = launcherAddress(typed, true)?.lead === true;
  const names = [...named, ...existing];
  const lead = certain ? [...actions, ...names] : [...names, ...actions];
  const pages = launcherPages(target ? { url: target.url, label: "", lead: true } : null, ctx.history, 2).map(
    (page): BlankRow => {
      const short = shortUrl(page.url);
      // A page that never named itself is titled by its address: said once.
      const title = page.title.trim();
      const named = title !== "" && title !== short && title !== page.url;
      return { id: `page:${page.urlKey}`, kind: "page", url: page.url, title: named ? title : short, detail: named ? short : "" };
    },
  );
  return [...lead, ...pages];
}

/** What a row is found by. */
function rowName(row: BlankRow): string {
  if (row.kind === "setup") return SETUP_TITLE;
  return row.kind === "new" ? KIND_TITLES[row.what] : "";
}

const matches = (typed: string, name: string) => wordsMatch(typed, name) !== null;

const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** "Open localhost:3001" over "/login"; a file by its name over its path. */
function openRow(url: string, label: string): BlankRow {
  if (url.startsWith("file:") || !/^https?:/i.test(url)) {
    const name = label.split("/").pop() || label;
    return { id: "open", kind: "open", url, title: `Open ${name}`, detail: label };
  }
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`.replace(/^\/$/, "");
    return { id: "open", kind: "open", url, title: `Open ${parsed.host}`, detail: rest };
  } catch {
    return { id: "open", kind: "open", url, title: `Open ${shortUrl(url)}`, detail: "" };
  }
}

/** "Google": the engine the address bar searches with, by its template. */
export function engineName(template: string): string {
  const known = SEARCH_ENGINES.find((engine) => engine.template === template);
  if (known) return known.label;
  try {
    return new URL(template.replace("%s", "")).host.replace(/^www\./, "");
  } catch {
    return "the web";
  }
}
