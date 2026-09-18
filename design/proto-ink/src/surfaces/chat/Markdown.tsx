import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { host } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { highlightCached, normaliseLang } from "@/lib/highlight";
import { useApp } from "@/lib/store";
import { DiffBlock } from "@/surfaces/DiffView";
import { Tooltip } from "@/ui";

/** A path-shaped run inside prose becomes a chip that opens the file. */
const PATH = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,5}(?::\d+(?::\d+)?)?/g;

function FileChip({ path }: { path: string }) {
  const { actions } = useApp();
  const relative = path.split(":")[0]!;
  return (
    <button
      type="button"
      onClick={() => actions.openFile(relative)}
      className={cx(
        "mx-[1px] inline-flex max-w-full items-baseline gap-1 rounded-sm px-1 align-baseline",
        "bg-[var(--fill-quaternary)] font-mono text-[0.92em] text-secondary",
        "transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-tertiary)] hover:text-primary",
      )}
    >
      {path}
    </button>
  );
}

/** Walks rendered children and turns bare file paths into chips. */
function chipify(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of child.matchAll(PATH)) {
      const at = match.index ?? 0;
      if (at > last) parts.push(child.slice(last, at));
      parts.push(<FileChip key={`${at}-${match[0]}`} path={match[0]} />);
      last = at + match[0].length;
    }
    if (parts.length === 0) return child;
    if (last < child.length) parts.push(child.slice(last));
    return <>{parts}</>;
  });
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
      }}
      className={cx(
        "flex size-5 shrink-0 items-center justify-center rounded-sm text-icon-faint",
        "transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-tertiary)] hover:text-icon",
      )}
    >
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}

function Fence({ code, lang }: { code: string; lang?: string }) {
  if (lang === "diff") {
    return (
      <div className="my-2">
        <DiffBlock patch={code} />
      </div>
    );
  }
  const resolved = normaliseLang(lang);
  const lines = highlightCached(code.slice(0, 64), code, resolved);
  return (
    <div className="my-2 overflow-hidden rounded-card bg-canvas hairline">
      <div className="flex h-7 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-2">
        <span className="text-micro uppercase tracking-[0.06em] text-quaternary">
          {lang ?? "text"}
        </span>
        <span className="flex-1" />
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre
        className="ink-scroll ink-skip overflow-x-auto px-3 py-2"
        style={{ containIntrinsicSize: `auto ${Math.min(lines.length, 40) * 18 + 16}px` }}
      >
        <code className="ink-mono block whitespace-pre text-primary">
          {lines.map((line, i) => (
            <span key={i} className="block min-h-[18px] leading-[18px]">
              {line.map((token, j) => (
                <span key={j} className={`tok-${token.cls}`}>
                  {token.text}
                </span>
              ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-title font-[var(--weight-strong)] text-primary first:mt-0">
      {chipify(children)}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-4 text-prose font-[var(--weight-strong)] text-primary first:mt-0">
      {chipify(children)}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-body font-[var(--weight-strong)] text-primary first:mt-0">
      {chipify(children)}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-body font-[var(--weight-medium)] text-secondary first:mt-0">
      {chipify(children)}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-3 text-small font-[var(--weight-medium)] uppercase tracking-[0.06em] text-tertiary first:mt-0">
      {chipify(children)}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-3 text-micro font-[var(--weight-medium)] uppercase tracking-[0.06em] text-quaternary first:mt-0">
      {chipify(children)}
    </h6>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{chipify(children)}</p>,
  strong: ({ children }) => (
    <strong className="font-[var(--weight-strong)] text-primary">{chipify(children)}</strong>
  ),
  em: ({ children }) => <em className="italic">{chipify(children)}</em>,
  del: ({ children }) => (
    <del className="text-tertiary decoration-[var(--stroke-primary)]">{chipify(children)}</del>
  ),
  hr: () => <hr className="my-4 h-px border-0 bg-[var(--stroke-tertiary)]" />,
  ul: ({ children, ...rest }) => {
    const isTaskList = (rest as { className?: string }).className?.includes("contains-task-list");
    return (
      <ul
        className={cx(
          "my-2 flex flex-col gap-1",
          isTaskList ? "pl-1" : "list-disc pl-5 marker:text-quaternary",
        )}
      >
        {children}
      </ul>
    );
  },
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:text-quaternary marker:tnum">
      {children}
    </ol>
  ),
  li: ({ children, ...rest }) => {
    const props = rest as { className?: string };
    if (props.className?.includes("task-list-item")) {
      const items = Children.toArray(children);
      const box = items.find(
        (item): item is ReactElement<{ checked?: boolean }> =>
          isValidElement(item) && item.type === "input",
      );
      const rest2 = items.filter((item) => item !== box);
      return (
        <li className="flex list-none items-start gap-2">
          <span
            className={cx(
              "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-xs",
              box?.props.checked
                ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
                : "hairline bg-canvas",
            )}
          >
            {box?.props.checked && <Icon name="check" size={11} strokeWidth={2.5} />}
          </span>
          <span className={cx("min-w-0", box?.props.checked && "text-tertiary")}>
            {chipify(rest2)}
          </span>
        </li>
      );
    }
    return (
      <li className="marker:text-quaternary [&>ul]:my-1 [&>ol]:my-1">{chipify(children)}</li>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--stroke-secondary)] pl-3 text-tertiary [&_blockquote]:my-1.5">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <Tooltip content={href ? host(href) : ""}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cx(
          "inline-flex items-baseline gap-0.5 text-[var(--accent)]",
          "underline decoration-[color-mix(in_oklch,var(--accent)_40%,transparent)] underline-offset-2",
          "transition-colors hover:decoration-[var(--accent)]",
        )}
      >
        {/* A real favicon is a network request; a globe is the same signal, offline. */}
        <Icon name="globe" size={12} className="translate-y-px opacity-60" />
        {children}
        <Icon name="external" size={12} className="translate-y-px opacity-60" />
      </a>
    </Tooltip>
  ),
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      loading="lazy"
      className="my-2 max-w-full rounded-card hairline"
    />
  ),
  table: ({ children }) => (
    // The table scrolls inside its own box; a wide table never widens the column.
    <div
      className="ink-scroll ink-skip my-3 overflow-x-auto rounded-card hairline"
      style={{ containIntrinsicSize: "auto 240px" }}
    >
      <table className="w-full min-w-max border-collapse text-small [overflow-wrap:normal]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--fill-quaternary)]">{children}</thead>,
  th: ({ children, ...rest }) => (
    <th
      style={{ textAlign: (rest as { style?: CSSProperties }).style?.textAlign ?? "left" }}
      className="whitespace-nowrap border-b border-[var(--stroke-tertiary)] px-2.5 py-1.5 font-[var(--weight-medium)] text-secondary"
    >
      {children}
    </th>
  ),
  td: ({ children, ...rest }) => (
    <td
      style={{ textAlign: (rest as { style?: CSSProperties }).style?.textAlign ?? "left" }}
      className="border-b border-[var(--stroke-tertiary)] px-2.5 py-1.5 align-top text-secondary last:border-b-0"
    >
      {chipify(children)}
    </td>
  ),
  tr: ({ children }) => <tr className="last:[&>td]:border-b-0">{children}</tr>,
  code: ({ className, children }) => {
    if (className?.includes("language-")) return <>{children}</>;
    return (
      <code className="rounded-sm bg-[var(--fill-quaternary)] px-1 py-px font-mono text-[0.92em] text-primary">
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    const child = Children.toArray(children)[0];
    const props = isValidElement<{ className?: string; children?: ReactNode }>(child)
      ? child.props
      : undefined;
    const lang = /language-([\w+-]+)/.exec(props?.className ?? "")?.[1];
    const code = String(props?.children ?? "").replace(/\n$/, "");
    return <Fence code={code} {...(lang ? { lang } : {})} />;
  },
  sup: ({ children }) => <sup className="text-[0.7em] text-[var(--accent)]">{children}</sup>,
  section: ({ children, ...rest }) => {
    const props = rest as { className?: string };
    if (props.className?.includes("footnotes")) {
      return (
        <section className="mt-4 border-t border-[var(--stroke-tertiary)] pt-2 text-small text-tertiary [&_h2]:sr-only [&_ol]:pl-4 [&_p]:my-1">
          {children}
        </section>
      );
    }
    return <section>{children}</section>;
  },
};

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "text-prose text-secondary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        // A 400-character identifier is content, not a layout bug: it wraps
        // rather than widening the column.
        "[overflow-wrap:anywhere]",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Words mount once and keep their DOM node, so a settled paragraph never
 * re-animates. The fade length tracks how fast tokens are actually arriving:
 * a fast stream fades short, a slow one fades long, and the text reads at one
 * pace either way.
 */
function WordStream({ text }: { text: string }) {
  const words = useMemo(() => text.match(/\S+\s*|\s+/g) ?? [], [text]);
  const rate = useRef({ at: performance.now(), count: 0, ema: 12 });

  const now = performance.now();
  const gap = now - rate.current.at;
  if (words.length > rate.current.count && gap > 0) {
    const perWord = gap / (words.length - rate.current.count);
    rate.current.ema = rate.current.ema * 0.7 + perWord * 0.3;
    rate.current.at = now;
    rate.current.count = words.length;
  }
  const fade = Math.max(120, Math.min(420, Math.round(rate.current.ema * 9)));

  return (
    <span style={{ "--fade-dur": `${fade}ms` } as CSSProperties}>
      {words.map((word, i) => (
        <span key={i} className="ink-fade-in whitespace-pre-wrap">
          {word}
        </span>
      ))}
    </span>
  );
}

/**
 * Complete blocks render as markdown and are memoised; only the trailing
 * incomplete block streams. When the tail completes it moves into the memoised
 * half without replaying its fade.
 */
export function StreamingMarkdown({ text, className }: { text: string; className?: string }) {
  const split = text.lastIndexOf("\n\n");
  const head = split > 0 ? text.slice(0, split) : "";
  const tail = split > 0 ? text.slice(split + 2) : text;
  return (
    <div className={cx("text-prose text-secondary", className)}>
      {head && <Markdown text={head} />}
      <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">
        <WordStream text={tail} />
        <span className="ink-caret" />
      </p>
    </div>
  );
}
