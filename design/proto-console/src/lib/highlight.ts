/**
 * A small, synchronous tokenizer.
 *
 * Shiki was the obvious choice and was rejected on purpose: its themes ship
 * literal hex, which would put colour outside the token set, and its async
 * `createHighlighter` makes a code fence paint one frame after the text around
 * it — the exact layout shift the brief forbids. This covers the six languages
 * the fixtures actually contain and maps every token onto a CSS variable.
 */

export type Cls =
  | "plain"
  | "kw"
  | "str"
  | "num"
  | "com"
  | "fn"
  | "type"
  | "punct"
  | "attr"
  | "meta";

export type Token = { t: string; c: Cls };

export type Lang =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "rust"
  | "css"
  | "json"
  | "bash"
  | "md"
  | "html"
  | "toml"
  | "text";

const ALIAS: Record<string, Lang> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  rust: "rust",
  rs: "rust",
  css: "css",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  markdown: "md",
  md: "md",
  html: "html",
  toml: "toml",
  yaml: "toml",
  yml: "toml",
};

export function langOf(hint: string | undefined | null): Lang {
  if (!hint) return "text";
  return ALIAS[hint.toLowerCase().trim()] ?? "text";
}

export function langFromPath(path: string): Lang {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return langOf(ext === "mts" ? "ts" : ext);
}

const TS_KEYWORDS = new Set(
  `const let var function return if else for while do class extends implements interface type enum
   import export from as default new await async yield try catch finally throw switch case break
   continue typeof instanceof in of delete void this super static public private protected readonly
   abstract declare namespace satisfies keyof infer is get set`.split(/\s+/),
);
const TS_LITERALS = new Set("null undefined true false NaN Infinity".split(" "));

const RUST_KEYWORDS = new Set(
  `fn let mut pub use mod struct enum impl trait for in if else match while loop return where type
   const static unsafe async await dyn move ref as break continue crate super extern box yield`.split(
    /\s+/,
  ),
);
const RUST_LITERALS = new Set("true false self Self None Some Ok Err".split(" "));

const BASH_KEYWORDS = new Set(
  `if then elif else fi for while until do done case esac function return in export local source
   set unset trap shift eval exec exit`.split(/\s+/),
);

const JSON_LITERALS = new Set("true false null".split(" "));

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?[a-z%]*/y;
const SPACE = /\s+/y;

function keywordsFor(lang: Lang): { kw: Set<string>; lit: Set<string> } {
  switch (lang) {
    case "rust":
      return { kw: RUST_KEYWORDS, lit: RUST_LITERALS };
    case "bash":
      return { kw: BASH_KEYWORDS, lit: new Set() };
    case "json":
      return { kw: new Set(), lit: JSON_LITERALS };
    default:
      return { kw: TS_KEYWORDS, lit: TS_LITERALS };
  }
}

function push(out: Token[], t: string, c: Cls) {
  if (!t) return;
  const last = out.at(-1);
  if (last && last.c === c) last.t += t;
  else out.push({ t, c });
}

function readString(code: string, at: number, quote: string): number {
  let i = at + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n" && quote !== "`") return i;
    i += 1;
  }
  return i;
}

export function tokenize(code: string, lang: Lang): Token[] {
  if (lang === "text" || lang === "md") return [{ t: code, c: "plain" }];
  if (lang === "css") return tokenizeCss(code);
  if (lang === "html") return tokenizeHtml(code);
  if (lang === "toml") return tokenizeToml(code);

  const { kw, lit } = keywordsFor(lang);
  const lineComment = lang === "bash" ? "#" : "//";
  const out: Token[] = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;

    SPACE.lastIndex = i;
    const space = SPACE.exec(code);
    if (space) {
      push(out, space[0], "plain");
      i = SPACE.lastIndex;
      continue;
    }

    if (code.startsWith(lineComment, i)) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push(out, code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    if (lang !== "bash" && code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      push(out, code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const stop = readString(code, i, ch);
      push(out, code.slice(i, stop), "str");
      i = stop;
      continue;
    }
    if (lang === "rust" && ch === "#" && code[i + 1] === "[") {
      const end = code.indexOf("]", i);
      const stop = end === -1 ? code.length : end + 1;
      push(out, code.slice(i, stop), "meta");
      i = stop;
      continue;
    }
    if (lang === "bash" && (ch === "$" || ch === "-")) {
      IDENT.lastIndex = i + 1;
      const ident = IDENT.exec(code);
      if (ident) {
        push(out, code.slice(i, IDENT.lastIndex), ch === "$" ? "meta" : "attr");
        i = IDENT.lastIndex;
        continue;
      }
    }

    NUMBER.lastIndex = i;
    if (/[0-9]/.test(ch)) {
      const num = NUMBER.exec(code);
      if (num) {
        push(out, num[0], "num");
        i = NUMBER.lastIndex;
        continue;
      }
    }

    IDENT.lastIndex = i;
    const ident = IDENT.exec(code);
    if (ident) {
      const word = ident[0];
      const next = code.slice(IDENT.lastIndex).match(/^\s*/)?.[0].length ?? 0;
      const after = code[IDENT.lastIndex + next];
      let cls: Cls = "plain";
      if (kw.has(word)) cls = "kw";
      else if (lit.has(word)) cls = "num";
      else if (lang === "json" && after === ":") cls = "attr";
      else if (after === "(" || (lang === "rust" && code.startsWith("!(", IDENT.lastIndex)))
        cls = "fn";
      else if (/^[A-Z]/.test(word)) cls = "type";
      push(out, word, cls);
      i = IDENT.lastIndex;
      continue;
    }

    push(out, ch, /[{}[\]();,.:?<>=+\-*/%!&|^~]/.test(ch) ? "punct" : "plain");
    i += 1;
  }
  return out;
}

function tokenizeCss(code: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    SPACE.lastIndex = i;
    const space = SPACE.exec(code);
    if (space) {
      push(out, space[0], "plain");
      i = SPACE.lastIndex;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      push(out, code.slice(i, stop), "com");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const stop = readString(code, i, ch);
      push(out, code.slice(i, stop), "str");
      i = stop;
      continue;
    }
    const at = /@[\w-]+/y;
    at.lastIndex = i;
    const atRule = at.exec(code);
    if (atRule) {
      push(out, atRule[0], "kw");
      i = at.lastIndex;
      continue;
    }
    const custom = /--[\w-]+/y;
    custom.lastIndex = i;
    const variable = custom.exec(code);
    if (variable) {
      push(out, variable[0], "attr");
      i = custom.lastIndex;
      continue;
    }
    const hex = /#[0-9a-fA-F]{3,8}\b/y;
    hex.lastIndex = i;
    const colour = hex.exec(code);
    if (colour) {
      push(out, colour[0], "num");
      i = hex.lastIndex;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      NUMBER.lastIndex = i;
      const num = NUMBER.exec(code);
      if (num) {
        push(out, num[0], "num");
        i = NUMBER.lastIndex;
        continue;
      }
    }
    const word = /[\w-]+/y;
    word.lastIndex = i;
    const ident = word.exec(code);
    if (ident) {
      const after = code.slice(word.lastIndex).match(/^\s*/)?.[0].length ?? 0;
      const next = code[word.lastIndex + after];
      push(out, ident[0], next === ":" ? "type" : next === "(" ? "fn" : "plain");
      i = word.lastIndex;
      continue;
    }
    push(out, ch, /[.#&>+~*]/.test(ch) ? "kw" : "punct");
    i += 1;
  }
  return out;
}

function tokenizeHtml(code: string): Token[] {
  const out: Token[] = [];
  const pattern = /(<!--[\s\S]*?-->)|(<\/?[\w-]+)|([\w-]+)(?==)|("[^"]*"|'[^']*')|(>|\/>)/g;
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) push(out, code.slice(last, at), "plain");
    const [text, comment, tag, attr, str, close] = match;
    if (comment) push(out, text, "com");
    else if (tag) push(out, text, "kw");
    else if (attr) push(out, text, "attr");
    else if (str) push(out, text, "str");
    else if (close) push(out, text, "kw");
    last = at + text.length;
  }
  if (last < code.length) push(out, code.slice(last), "plain");
  return out;
}

function tokenizeToml(code: string): Token[] {
  const out: Token[] = [];
  for (const line of code.split(/(?<=\n)/)) {
    if (/^\s*#/.test(line)) {
      push(out, line, "com");
      continue;
    }
    const section = /^\s*\[.*\]\s*$/.exec(line);
    if (section) {
      push(out, line, "kw");
      continue;
    }
    const pair = /^(\s*)([\w.-]+)(\s*[:=]\s*)(.*)$/.exec(line);
    if (pair) {
      push(out, pair[1]!, "plain");
      push(out, pair[2]!, "attr");
      push(out, pair[3]!, "punct");
      push(out, pair[4]!, /^["']/.test(pair[4]!.trim()) ? "str" : "num");
      continue;
    }
    push(out, line, "plain");
  }
  return out;
}

/** Tokens split at newlines, so a line-numbered gutter can pair with them. */
export function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.t.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ t: part, c: token.c });
    });
  }
  return lines;
}

const cache = new Map<string, Token[][]>();
const CACHE_LIMIT = 200;

/** Highlighting is pure, and the same fence is re-rendered on every delta. */
export function highlightLines(code: string, lang: Lang): Token[][] {
  const key = `${lang} ${code}`;
  const held = cache.get(key);
  if (held) return held;
  const lines = toLines(tokenize(code, lang));
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, lines);
  return lines;
}
