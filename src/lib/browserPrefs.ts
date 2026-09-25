import { DEFAULT_KEEP } from "./browser/retention";

export type BrowserPrefs = {
  /** Where a query typed into the address bar goes; `%s` is the encoded query. */
  searchTemplate: string;
  /** Hidden pages that keep a live guest; the rest go cold until shown. */
  keep: number;
  /** Web links in chats and terminals open as a page here instead of in the default browser. */
  openLinksInCrew: boolean;
};

export const SEARCH_ENGINES = [
  { id: "google", label: "Google", template: "https://www.google.com/search?q=%s" },
  { id: "duckduckgo", label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  { id: "bing", label: "Bing", template: "https://www.bing.com/search?q=%s" },
  { id: "brave", label: "Brave Search", template: "https://search.brave.com/search?q=%s" },
  { id: "kagi", label: "Kagi", template: "https://kagi.com/search?q=%s" },
] as const;

/** Each one a guest process kept warm: more is instant revisits, fewer is less memory. */
export const KEEP_CHOICES = [2, 4, 6, 10] as const;

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  searchTemplate: SEARCH_ENGINES[0].template,
  keep: DEFAULT_KEEP,
  openLinksInCrew: false,
};

/** Anything unknown falls back field by field, so a bad value never takes the browser down. */
export function parseBrowserPrefs(raw: string | null): BrowserPrefs {
  if (!raw) return DEFAULT_BROWSER_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_BROWSER_PREFS;
    const { searchTemplate, keep, openLinksInCrew } = parsed as Partial<Record<keyof BrowserPrefs, unknown>>;
    return {
      searchTemplate: SEARCH_ENGINES.some((engine) => engine.template === searchTemplate)
        ? (searchTemplate as string)
        : DEFAULT_BROWSER_PREFS.searchTemplate,
      keep: KEEP_CHOICES.includes(keep as (typeof KEEP_CHOICES)[number])
        ? (keep as number)
        : DEFAULT_BROWSER_PREFS.keep,
      openLinksInCrew:
        typeof openLinksInCrew === "boolean" ? openLinksInCrew : DEFAULT_BROWSER_PREFS.openLinksInCrew,
    };
  } catch {
    return DEFAULT_BROWSER_PREFS;
  }
}
