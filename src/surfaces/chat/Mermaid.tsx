import { useEffect, useState } from "react";
import { isDark, onSchemeChange, renderedMermaid, renderMermaid } from "../../lib/markdown/mermaid";

/**
 * A mermaid fence drawn as its diagram, in the scheme the app is in. Mermaid
 * loads on the first diagram and caches by source, so a chat scrolled back
 * over one repaints it at once. A source mermaid cannot parse hands the block
 * back to `onFail`, which shows it as code.
 */
export function Mermaid({ code, onFail }: { code: string; onFail: () => void }) {
  const [dark, setDark] = useState(isDark);
  const [svg, setSvg] = useState(() => renderedMermaid(code, dark) ?? null);

  useEffect(() => onSchemeChange(() => setDark(isDark())), []);

  useEffect(() => {
    let cancelled = false;
    renderMermaid(code, dark).then(
      (markup) => !cancelled && setSvg(markup),
      () => !cancelled && onFail(),
    );
    return () => {
      cancelled = true;
    };
  }, [code, dark, onFail]);

  if (!svg) return <div className="crew-mermaid h-24" aria-busy />;
  // Mermaid renders with securityLevel "strict": scripts and handlers are gone.
  return <div className="crew-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
