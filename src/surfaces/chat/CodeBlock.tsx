import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { memo, useEffect, useState } from "react";
import { highlightInline, resolveLang } from "../../lib/shiki";
import { DiffFence } from "./DiffView";

type Props = {
  code: string;
  lang?: string;
  /** Still arriving token by token; tokenizing every keystroke would be wasted work. */
  streaming?: boolean;
};

const SETTLE_MS = 150;
const DIFF = /^(?:diff|patch)$/i;

/** One box: language and copy on top, code below. Plain text until shiki answers. */
export const CodeBlock = memo(function CodeBlock({ code, lang, streaming }: Props) {
  const diff = lang !== undefined && DIFF.test(lang);
  const language = diff ? null : resolveLang(lang);
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

  const ready = html !== null && html.code === code;

  return (
    <div className="crew-code" data-lang={lang ?? ""}>
      <div className="crew-code-head">
        <span>{lang || "text"}</span>
        <CopyButton code={code} />
      </div>
      {diff && !streaming ? (
        <DiffFence code={code} />
      ) : (
        <pre className="crew-code-body">
          {ready ? <code dangerouslySetInnerHTML={{ __html: html.html }} /> : <code>{code}</code>}
        </pre>
      )}
    </div>
  );
});

function CopyButton({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : "Copy code"}
      title="Copy"
      onClick={() => void navigator.clipboard.writeText(code).then(() => setDone(true))}
      className="crew-code-copy"
    >
      {done ? <CheckIcon className="size-3.5" weight="bold" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
