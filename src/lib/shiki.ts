import type { HighlighterCore } from "shiki";
import { LANGS } from "./highlighting";

/**
 * One highlighter for the chat, loaded on first use. Grammars load on demand
 * so the window never pays for languages nobody pasted. The diff editor has
 * its own worker; sharing shiki's module cache is all the reuse we need.
 */
let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

export const THEMES = { light: "min-light", dark: "min-dark" } as const;

const ALIASES: Record<string, string> = {
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript",
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript",
  yml: "yaml", md: "markdown", py: "python", rb: "ruby", rs: "rust", docker: "dockerfile",
};

const KNOWN = new Set<string>(LANGS);

export function resolveLang(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  const lang = ALIASES[key] ?? key;
  return KNOWN.has(lang) ? lang : null;
}

async function get(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("@shikijs/themes/min-light"),
        import("@shikijs/themes/min-dark"),
      ]);
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighter;
}

async function ensureLang(core: HighlighterCore, lang: string): Promise<void> {
  if (loaded.has(lang)) return;
  let pending = loading.get(lang);
  if (!pending) {
    pending = import("shiki").then(async ({ bundledLanguages }) => {
      const load = bundledLanguages[lang as keyof typeof bundledLanguages];
      if (!load) throw new Error(`no grammar for ${lang}`);
      await core.loadLanguage(load);
      loaded.add(lang);
    });
    loading.set(lang, pending);
  }
  await pending;
}

/** Spans only, one `<br>` per line break; the caller owns `<pre><code>`. `null` when the grammar is missing. */
export async function highlightInline(code: string, lang: string): Promise<string | null> {
  const core = await get();
  try {
    await ensureLang(core, lang);
  } catch {
    return null;
  }
  return core.codeToHtml(code, {
    lang,
    themes: THEMES,
    defaultColor: false,
    structure: "inline",
  });
}
