import { Fragment, memo, type ReactNode } from "react";

/**
 * A deliberately small synchronous highlighter.
 *
 * Shiki is in the dependency list and looks better, but it resolves a theme
 * asynchronously: the transcript would paint plain text, then re-paint coloured
 * text, and every line below the change would move. A stick-to-bottom scroller
 * with a 16px threshold cannot survive that. This runs inline, during render.
 */
export type Lang = "ts" | "tsx" | "js" | "rust" | "css" | "json" | "bash" | "md" | "text";

const KEYWORDS: Record<string, string> = {
  ts: "import|export|from|const|let|var|function|return|if|else|for|while|switch|case|default|break|continue|new|class|extends|implements|interface|type|enum|as|in|of|typeof|instanceof|await|async|try|catch|finally|throw|yield|this|super|null|undefined|true|false|void|never|unknown|any|readonly|satisfies|declare|namespace|public|private|protected|static|get|set",
  rust: "pub|fn|let|mut|const|static|struct|enum|impl|trait|for|in|while|loop|match|if|else|return|use|mod|crate|self|Self|super|where|async|await|move|ref|dyn|as|type|unsafe|extern|Some|None|Ok|Err|true|false",
  css: "important|from|to|and|not|only|screen|print",
  json: "true|false|null",
  bash: "if|then|else|fi|for|in|do|done|while|case|esac|function|return|export|local|echo|cd|npm|cargo|git|node|npx",
};

const LANG_ALIAS: Record<string, Lang> = {
  ts: "ts",
  typescript: "ts",
  tsx: "ts",
  js: "ts",
  javascript: "ts",
  jsx: "ts",
  rust: "rust",
  rs: "rust",
  css: "css",
  json: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
};

export const normaliseLang = (raw?: string): Lang =>
  (raw && LANG_ALIAS[raw.toLowerCase()]) || "text";

export const langFromPath = (path: string): Lang => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "mts") return "ts";
  if (ext === "rs") return "rust";
  if (ext === "css") return "css";
  if (ext === "json") return "json";
  if (ext === "sh" || ext === "bash") return "bash";
  if (ext === "md") return "md";
  return "text";
};

type Token = { text: string; cls: string };

const CLS: Record<string, string> = {
  keyword: "text-[var(--syn-keyword)]",
  string: "text-[var(--syn-string)]",
  comment: "text-[var(--syn-comment)] italic",
  number: "text-[var(--syn-number)]",
  type: "text-[var(--syn-type)]",
  fn: "text-[var(--syn-fn)]",
  punct: "text-[var(--syn-punct)]",
  plain: "",
};

function tokenize(line: string, lang: Lang): Token[] {
  if (lang === "text" || lang === "md") return [{ text: line, cls: "plain" }];
  const keywords = KEYWORDS[lang] ?? KEYWORDS.ts!;
  const pattern = new RegExp(
    [
      "(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)", // comment
      "(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)", // string
      `\\b(${keywords})\\b`,
      "\\b([A-Z][A-Za-z0-9_]*)\\b", // type-ish
      "\\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\\()", // call
      "\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b", // number
      "([{}()\\[\\];,.:<>=+\\-*/!&|?])", // punctuation
    ].join("|"),
    "g",
  );

  const out: Token[] = [];
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: line.slice(last, at), cls: "plain" });
    const cls = match[1]
      ? "comment"
      : match[2]
        ? "string"
        : match[3]
          ? "keyword"
          : match[4]
            ? "type"
            : match[5]
              ? "fn"
              : match[6]
                ? "number"
                : "punct";
    out.push({ text: match[0], cls });
    last = at + match[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), cls: "plain" });
  return out;
}

export const Highlighted = memo(function Highlighted({ code, lang }: { code: string; lang: Lang }): ReactNode {
  const lines = code.split("\n");
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {tokenize(line, lang).map((token, i) => (
            <span key={i} className={CLS[token.cls]}>
              {token.text}
            </span>
          ))}
          {index < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </>
  );
});

export const HighlightedLine = memo(function HighlightedLine({ line, lang }: { line: string; lang: Lang }) {
  return (
    <>
      {tokenize(line, lang).map((token, i) => (
        <span key={i} className={CLS[token.cls]}>
          {token.text}
        </span>
      ))}
    </>
  );
});
