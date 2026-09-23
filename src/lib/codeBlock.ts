import { resolveLang } from "./shiki";

const DIFF = /^(?:diff|patch)$/i;

/** A ```diff or ```patch fence renders as a diff, not as highlighted text. */
export function isDiffLang(lang: string | undefined): boolean {
  return lang !== undefined && DIFF.test(lang);
}

/** The grammar to highlight with, or null for plain text (and for diffs, which have their own view). */
export function codeLanguage(lang: string | undefined): string | null {
  return isDiffLang(lang) ? null : resolveLang(lang);
}
