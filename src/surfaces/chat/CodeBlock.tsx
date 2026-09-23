import { memo, useEffect, useState } from "react";
import { codeLanguage, isDiffLang } from "../../lib/codeBlock";
import { highlightInline } from "../../lib/shiki";
import { CopyButton } from "./CopyButton";
import { DiffFence } from "./DiffView";

type Props = {
  code: string;
  lang?: string;
  /** Still arriving token by token; tokenizing every keystroke would be wasted work. */
  streaming?: boolean;
};

const SETTLE_MS = 150;

/** One box: language and copy on top, code below. Plain text until shiki answers. */
export const CodeBlock = memo(function CodeBlock({ code, lang, streaming }: Props) {
  const diff = isDiffLang(lang);
  const language = codeLanguage(lang);
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
        <CopyButton text={code} />
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
