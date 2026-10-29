import type { SupportedLanguages } from "@pierre/diffs";

/**
 * Shiki ships ~200 grammars and Vite emits one lazy chunk per grammar, so an
 * unrestricted highlighter turned `dist/` into 11 MB. This is the curated set;
 * anything outside it renders as plain text.
 *
 * Every id must exist in shiki's `bundledLanguages`. "text" does not — passing
 * it here silently killed highlighting for every language.
 */
export const LANGS: SupportedLanguages[] = [
  "typescript", "tsx", "javascript", "jsx", "json", "jsonc",
  "php", "blade", "python", "ruby", "go", "rust", "java", "swift",
  "html", "css", "scss", "vue", "svelte",
  "yaml", "toml", "xml", "sql", "markdown", "shellscript", "dockerfile",
  "diff", "ini",
];

/** Characters past which a file opens as plain text: tokenizing costs more than the highlight is worth. */
export const TOKENIZE_MAX_LENGTH = 300_000;
export const TOKENIZE_MAX_LINE_LENGTH = 2_000;
/**
 * Characters past which the code editor has the worker pool highlight a file,
 * showing it plain until then: on the main thread that took ~5 ms a kilobyte
 * with the window frozen.
 */
export const OFFLOAD_HIGHLIGHT_MIN_LENGTH = 20_000;

export const THEME = { light: "pierre-light", dark: "pierre-dark" } as const;
