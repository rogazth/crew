/**
 * A small synchronous tokenizer.
 *
 * Shiki would be more faithful, but it paints with baked hex values and resolves
 * asynchronously — two things this design cannot have. Every token here lands on
 * a `--syn-*` custom property, so highlighting flips with the theme, and it is
 * synchronous, so code never reflows under a reader mid-scroll.
 */

export type TokenClass =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "property"
  | "tag"
  | "attribute"
  | "punctuation"
  | "regexp"
  | "plain";

export type Token = { text: string; cls: TokenClass };
export type Line = Token[];

type Rule = { cls: TokenClass; re: RegExp };

const rules = (...list: Array<[TokenClass, RegExp]>): Rule[] =>
  list.map(([cls, re]) => ({ cls, re: new RegExp(re.source, "y") }));

const WS = /[ \t]+/;

const TS_KEYWORDS =
  /\b(?:abstract|as|async|await|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|new|null|of|private|protected|public|readonly|return|satisfies|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b/;

const TS_TYPES =
  /\b(?:any|bigint|boolean|never|number|object|string|symbol|unknown|Array|Promise|Record|Map|Set|Partial|Omit|Pick|Readonly|React|Date|Math|JSON|Object|Error|RegExp|HTMLElement)\b/;

const RUST_KEYWORDS =
  /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\b/;

const RUST_TYPES =
  /\b(?:bool|char|f32|f64|i8|i16|i32|i64|i128|isize|str|u8|u16|u32|u64|u128|usize|String|Vec|Option|Result|Box|Arc|Rc|RefCell|Mutex|HashMap|HashSet|Some|None|Ok|Err)\b/;

const SHELL_KEYWORDS =
  /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|export|local|source|set|unset|echo|cd|exit)\b/;

const COMMON_NUMBER = /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/;

const LANGS: Record<string, Rule[]> = {
  ts: rules(
    ["comment", /\/\*[\s\S]*?(?:\*\/|$)/],
    ["comment", /\/\/[^\n]*/],
    ["string", /`(?:\\[\s\S]|[^\\`])*`?/],
    ["string", /"(?:\\[\s\S]|[^\\"\n])*"?/],
    ["string", /'(?:\\[\s\S]|[^\\'\n])*'?/],
    ["regexp", /\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/],
    ["number", COMMON_NUMBER],
    ["keyword", TS_KEYWORDS],
    ["type", TS_TYPES],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/],
    ["function", /\b[a-zA-Z_$][\w$]*(?=\s*\()/],
    ["property", /(?<=\.)[a-zA-Z_$][\w$]*/],
    ["variable", /\b[a-zA-Z_$][\w$]*\b/],
    ["punctuation", /[{}[\]();,.:?!<>=+\-*/%&|^~@#]+/],
  ),
  rust: rules(
    ["comment", /\/\*[\s\S]*?(?:\*\/|$)/],
    ["comment", /\/\/[^\n]*/],
    ["string", /r?#*"(?:\\[\s\S]|[^\\"])*"?#*/],
    ["string", /'(?:\\.|[^\\'])'/],
    ["attribute", /#!?\[[^\]\n]*\]/],
    ["number", COMMON_NUMBER],
    ["keyword", RUST_KEYWORDS],
    ["type", RUST_TYPES],
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/],
    ["function", /\b[a-z_][\w]*(?=\s*[(!])/],
    ["variable", /\b'?[a-zA-Z_][\w]*\b/],
    ["punctuation", /[{}[\]();,.:?!<>=+\-*/%&|^~@#]+/],
  ),
  css: rules(
    ["comment", /\/\*[\s\S]*?(?:\*\/|$)/],
    ["string", /"(?:\\.|[^\\"\n])*"?|'(?:\\.|[^\\'\n])*'?/],
    ["attribute", /--[\w-]+/],
    ["keyword", /@[\w-]+/],
    ["number", /-?\b\d[\d_]*(?:\.\d+)?(?:px|rem|em|%|vh|vw|ms|s|deg|fr|ch)?\b/],
    ["function", /\b[\w-]+(?=\s*\()/],
    ["property", /\b[a-z-]+(?=\s*:)/],
    ["tag", /[.#][\w-]+|\b[a-z]+\b(?=[^:;{}]*\{)/],
    ["punctuation", /[{}();,:>+~*]+/],
  ),
  json: rules(
    ["property", /"(?:\\.|[^\\"])*"(?=\s*:)/],
    ["string", /"(?:\\.|[^\\"])*"?/],
    ["number", /-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ["keyword", /\b(?:true|false|null)\b/],
    ["punctuation", /[{}[\],:]+/],
  ),
  shell: rules(
    ["comment", /#[^\n]*/],
    ["string", /"(?:\\.|[^\\"])*"?|'[^']*'?/],
    ["variable", /\$\{[^}]*\}|\$[\w@*#?]+/],
    ["attribute", /(?:^|\s)--?[\w-]+/],
    ["keyword", SHELL_KEYWORDS],
    ["number", COMMON_NUMBER],
    ["function", /^[ \t]*[\w./-]+/],
    ["punctuation", /[|&;()<>{}[\]]+/],
  ),
  toml: rules(
    ["comment", /#[^\n]*/],
    ["tag", /^\[[^\]\n]*\]/],
    ["string", /"(?:\\.|[^\\"])*"?|'[^']*'?/],
    ["number", COMMON_NUMBER],
    ["keyword", /\b(?:true|false)\b/],
    ["property", /^[ \t]*[\w.-]+(?=\s*=)/],
    ["punctuation", /[=,[\]{}]+/],
  ),
  md: rules(
    ["comment", /^>[^\n]*/],
    ["keyword", /^#{1,6}[^\n]*/],
    ["string", /`[^`\n]*`?/],
    ["tag", /\*\*[^*\n]+\*\*|__[^_\n]+__/],
    ["attribute", /\[[^\]\n]*\]\([^)\n]*\)/],
    ["punctuation", /^[ \t]*[-*+]\s|^[ \t]*\d+\.\s/],
  ),
  plain: [],
};

const ALIASES: Record<string, string> = {
  typescript: "ts",
  tsx: "ts",
  javascript: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  scss: "css",
  markdown: "md",
  mdx: "md",
  yml: "plain",
  yaml: "plain",
  html: "plain",
  text: "plain",
  txt: "plain",
};

export function normaliseLang(lang: string | undefined): string {
  if (!lang) return "plain";
  const key = lang.toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return resolved in LANGS ? resolved : "plain";
}

export function langOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.endsWith("Cargo.toml") || ext === "toml") return "toml";
  return normaliseLang(ext);
}

function tokenize(code: string, lang: string): Token[] {
  const set = LANGS[lang];
  if (!set || set.length === 0) return [{ text: code, cls: "plain" }];
  const out: Token[] = [];
  const ws = new RegExp(WS.source, "y");
  let i = 0;
  let pending = "";

  const flush = () => {
    if (pending) {
      out.push({ text: pending, cls: "plain" });
      pending = "";
    }
  };

  while (i < code.length) {
    const ch = code[i]!;
    if (ch === "\n") {
      pending += ch;
      i += 1;
      continue;
    }
    ws.lastIndex = i;
    const space = ws.exec(code);
    if (space) {
      pending += space[0];
      i = ws.lastIndex;
      continue;
    }
    let matched = false;
    for (const rule of set) {
      rule.re.lastIndex = i;
      const hit = rule.re.exec(code);
      if (hit && hit[0].length > 0) {
        flush();
        out.push({ text: hit[0], cls: rule.cls });
        i += hit[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      pending += ch;
      i += 1;
    }
  }
  flush();
  return out;
}

/** Tokens split at newlines, so a caller can paint or window one line at a time. */
export function highlightLines(code: string, lang: string): Line[] {
  const tokens = tokenize(code, normaliseLang(lang));
  const lines: Line[] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, cls: token.cls });
    });
  }
  return lines;
}

const cache = new Map<string, Line[]>();
const LIMIT = 4_000;

function fingerprint(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Highlighting the same body twice is common (editor, diff and preview all paint
 * the same lines). The id folds in a content hash, not just a length, because a
 * one-character edit keeps the length and would otherwise hand back stale tokens.
 * Eviction is oldest-first rather than wholesale, so a diff longer than the cache
 * still benefits from line-at-a-time reuse.
 */
export function highlightCached(key: string, code: string, lang: string): Line[] {
  const id = `${key}::${lang}::${code.length}::${fingerprint(code)}`;
  const held = cache.get(id);
  if (held) {
    cache.delete(id);
    cache.set(id, held);
    return held;
  }
  const lines = highlightLines(code, lang);
  if (cache.size >= LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, lines);
  return lines;
}
