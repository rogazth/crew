import clsx from "clsx";
import { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlightLines, langOf, tokenize, type Lang } from "@/lib/highlight";

/** One run of code, inline. Used by the diff view and the tool bodies. */
export const Code = memo(function Code({ text, lang }: { text: string; lang: Lang }) {
  const tokens = useMemo(() => tokenize(text, lang), [text, lang]);
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className={`tok-${token.c}`}>
          {token.t}
        </span>
      ))}
    </>
  );
});

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : "Copy"}
      title={done ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        window.setTimeout(() => setDone(false), 1_200);
      }}
      className={clsx(
        "grid size-4 shrink-0 place-items-center rounded-[var(--r)] text-ink-4 hover:text-ink",
        className,
      )}
    >
      {done ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.25} />}
    </button>
  );
}

/**
 * A fence gets a top rule and a right-aligned language tag. No window chrome, no
 * traffic lights, no border box — the rule is enough to say "this is code".
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang: langHint,
  numbers = false,
  className,
}: {
  code: string;
  lang?: string | null;
  numbers?: boolean;
  className?: string;
}) {
  const lang = langOf(langHint);
  const body = code.replace(/\n$/, "");
  const lines = useMemo(() => highlightLines(body, lang), [body, lang]);

  return (
    <figure className={clsx("group my-2 border-t border-rule", className)}>
      <figcaption className="flex h-5 items-center gap-2 px-0">
        <span className="ml-auto font-mono text-xs text-ink-4">{langHint || "text"}</span>
        <CopyButton text={body} className="opacity-0 group-hover:opacity-100" />
      </figcaption>
      <pre className="scroll overflow-x-auto pb-2 font-mono text-sm leading-[var(--lh-sm)]">
        <code>
          {lines.map((tokens, index) => (
            <span key={index} className="flex">
              {numbers ? (
                <span className="w-9 shrink-0 pr-3 text-right text-ink-4 select-none">
                  {index + 1}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 whitespace-pre">
                {tokens.length === 0 ? "\n" : null}
                {tokens.map((token, at) => (
                  <span key={at} className={`tok-${token.c}`}>
                    {token.t}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
});
