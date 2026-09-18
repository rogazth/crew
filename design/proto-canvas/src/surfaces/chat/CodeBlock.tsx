import { memo, useState } from "react";
import { cx } from "@/lib/cx";
import { Highlighted, normaliseLang } from "@/lib/highlight";
import { Icon } from "@/ui/Icon";

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  className,
  head,
}: {
  code: string;
  lang?: string;
  className?: string;
  head?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={cx("overflow-hidden rounded-card bg-raised el-1", className)}>
      <div className="flex h-8 items-center gap-2 border-b border-[var(--line-soft)] px-3">
        <Icon name="code" size={13} className="text-ink-38" />
        <span className="flex-1 truncate font-mono text-xs text-ink-52">{head ?? lang ?? "text"}</span>
        <button
          type="button"
          onClick={copy}
          className="rise-1 flex h-6 items-center gap-1 rounded-chip px-1.5 text-xs text-ink-52 hover:bg-sunken hover:text-ink"
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scroller overflow-x-auto bg-code-bg px-3 py-2.5 font-mono text-code text-code-ink">
        <code>
          <Highlighted code={code} lang={normaliseLang(lang)} />
        </code>
      </pre>
    </div>
  );
});
