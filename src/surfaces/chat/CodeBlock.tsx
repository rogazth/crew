import { CodeXmlIcon, WorkflowIcon, WrapTextIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { highlightInline, resolveLang } from "../../lib/shiki";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { CopyButton } from "./CopyButton";
import { useChatActions } from "./context";
import { DiffFence } from "./DiffView";
import { Mermaid } from "./Mermaid";

type Props = {
  code: string;
  lang?: string;
  /** The file the fence names (`title="src/a.ts"`); it heads the box and opens on click. */
  title?: string;
  /** Still arriving token by token; tokenizing every keystroke would be wasted work. */
  streaming?: boolean;
};

const SETTLE_MS = 150;
const DIFF = /^(?:diff|patch)$/i;

const MERMAID = /^mermaid$/i;

export function HeadButton({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`crew-code-copy${pressed ? " text-text" : ""}`}
    >
      {children}
    </button>
  );
}

/** shiki's markup for `code`, once it has settled; nothing while it streams or has no grammar. */
function useHighlight(code: string, language: ReturnType<typeof resolveLang>, streaming: boolean | undefined) {
  const [html, setHtml] = useState<{ code: string; html: string } | null>(null);
  useEffect(() => {
    if (!language || streaming) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void highlightInline(code, language).then((result) => {
        if (!cancelled && result) setHtml({ code, html: result });
      });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, language, streaming]);
  return html !== null && html.code === code ? html.html : null;
}

/** The file a fence names, or its language; clicking a file opens it. */
export function CodeLabel({ lang, title }: { lang: string | undefined; title: string | undefined }) {
  const { openPath } = useChatActions();
  if (!title) {
    return (
      <span className="flex items-center gap-1.5">
        <FileTypeIcon name={`code.${lang || "txt"}`} className="size-3.5" />
        {lang || "text"}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openPath(title)}
      title={`Open ${title}`}
      className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-text"
    >
      <FileTypeIcon name={title.split("/").pop() ?? title} className="size-3.5 shrink-0" />
      <span className="truncate">{title}</span>
    </button>
  );
}

/** What the head offers: diagram or source for mermaid, wrapping for code, copy for both. */
export function CodeControls({
  code,
  kind,
  source,
  wrap,
  onSource,
  onWrap,
}: {
  code: string;
  kind: "code" | "diff" | "diagram" | "diagram-source";
  source: boolean;
  wrap: boolean;
  onSource: () => void;
  onWrap: () => void;
}) {
  const mermaid = kind === "diagram" || kind === "diagram-source";
  return (
    <span className="flex items-center gap-0.5">
      {mermaid ? (
        <HeadButton label={source ? "Show diagram" : "Show source"} pressed={false} onClick={onSource}>
          {source ? <WorkflowIcon className="size-3.5" /> : <CodeXmlIcon className="size-3.5" />}
        </HeadButton>
      ) : null}
      {kind === "code" || kind === "diagram-source" ? (
        <HeadButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={onWrap}>
          <WrapTextIcon className="size-3.5" />
        </HeadButton>
      ) : null}
      <CopyButton text={code} />
    </span>
  );
}

/** How a fence draws: a diff and a diagram only once the fence has closed. */
function kindOf(lang: string | undefined, streaming: boolean, source: boolean) {
  if (streaming || lang === undefined) return "code" as const;
  if (DIFF.test(lang)) return "diff" as const;
  if (MERMAID.test(lang)) return source ? ("diagram-source" as const) : ("diagram" as const);
  return "code" as const;
}

/** One box: language (or the file it names) and its controls on top, code below. Plain text until shiki answers. */
export const CodeBlock = memo(function CodeBlock({ code, lang, title, streaming }: Props) {
  const [wrap, setWrap] = useState(false);
  const [source, setSource] = useState(false);
  const showSource = useCallback(() => setSource(true), []);
  const kind = kindOf(lang, streaming === true, source);
  const plain = lang !== undefined && (DIFF.test(lang) || MERMAID.test(lang));
  const html = useHighlight(code, plain ? null : resolveLang(lang), streaming);
  return (
    <div className="crew-code" data-lang={lang ?? ""}>
      <div className="crew-code-head">
        <CodeLabel lang={lang} title={title} />
        <CodeControls
          code={code}
          kind={kind}
          source={source}
          wrap={wrap}
          onSource={() => setSource((on) => !on)}
          onWrap={() => setWrap((on) => !on)}
        />
      </div>
      {kind === "diff" ? <DiffFence code={code} /> : null}
      {kind === "diagram" ? <Mermaid code={code} onFail={showSource} /> : null}
      {kind === "code" || kind === "diagram-source" ? (
        <pre className={`crew-code-body${wrap ? " is-wrapped" : ""}`}>
          {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
        </pre>
      ) : null}
    </div>
  );
});
