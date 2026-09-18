import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "@/lib/cx";
import { splitMarkdown, looksLikePath } from "@/lib/mdSegments";
import { useStore } from "@/lib/store";
import { Icon } from "@/ui/Icon";
import { Diff } from "../DiffView";
import { CodeBlock } from "./CodeBlock";

function FileChip({ path }: { path: string }) {
  const { openFile } = useStore();
  return (
    <button
      type="button"
      onClick={() => openFile(path.replace(/^\.?\//, ""))}
      className="rise-1 inline-flex h-[20px] max-w-full translate-y-[3px] items-center gap-1 rounded-chip bg-sunken px-1.5 align-baseline font-mono text-xs text-ink-70 hover:bg-raised hover:text-ink hover:el-1"
    >
      <Icon name="fileCode" size={11} className="shrink-0 opacity-70" />
      <span className="truncate">{path}</span>
    </button>
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-xl first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3.5 text-md first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-3 text-sm font-semibold uppercase tracking-wide text-ink-70 first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-ink-52 first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-52 line-through">{children}</del>,
  hr: () => <hr className="my-4 border-0 border-t border-[var(--line)]" />,
  ul: ({ children, className }) => (
    <ul className={cx("my-2 flex flex-col gap-1 pl-5", className?.includes("contains-task-list") && "list-none pl-0")}>
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:text-ink-38">{children}</ol>,
  li: ({ children, className }) => (
    <li
      className={cx(
        "leading-[21px]",
        className?.includes("task-list-item")
          ? "flex list-none items-start gap-2"
          : "list-disc marker:text-ink-38",
      )}
    >
      {children}
    </li>
  ),
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <span
        aria-hidden
        className={cx(
          "mt-[3px] grid size-[15px] shrink-0 place-items-center rounded-[5px]",
          checked ? "bg-accent text-on-accent el-1" : "bg-raised el-2",
        )}
      >
        {checked && <Icon name="check" size={11} />}
      </span>
    ) : null,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--accent-line)] pl-3 text-ink-70">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-baseline gap-1 text-accent-text underline decoration-[var(--accent-line)] underline-offset-2 hover:decoration-current"
    >
      <Icon name="globe" size={11} className="translate-y-[2px] opacity-60" />
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} className="my-2 max-w-full rounded-card el-1" />
  ),
  code: ({ children }) => {
    const text = String(children);
    if (looksLikePath(text)) return <FileChip path={text} />;
    return (
      <code className="rounded-[5px] bg-sunken px-1 py-0.5 font-mono text-[0.92em] text-ink">{children}</code>
    );
  },
  table: ({ children }) => (
    <div className="scroller mask-fade-r max-w-full overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-base">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-sunken">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="whitespace-nowrap border-b border-[var(--line)] px-3 py-2 text-left text-sm font-semibold text-ink-70">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="whitespace-nowrap border-b border-[var(--line-soft)] px-3 py-2 align-top">
      {children}
    </td>
  ),
  section: ({ children, className }) =>
    className?.includes("footnotes") ? (
      <section className="mt-4 border-t border-[var(--line-soft)] pt-2 text-sm text-ink-52">{children}</section>
    ) : (
      <section>{children}</section>
    ),
  sup: ({ children }) => <sup className="text-xs text-accent-text">{children}</sup>,
};

const Prose = memo(function Prose({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {source}
    </ReactMarkdown>
  );
});

/**
 * Renders one assistant body as an alternating sequence of bubbles and cards.
 * `bubble` wraps the prose runs; widgets are handed straight through.
 */
export const Markdown = memo(function Markdown({
  source,
  bubble,
}: {
  source: string;
  bubble: (content: ReactNode, key: string) => ReactNode;
}) {
  const segments = splitMarkdown(source);
  return (
    <>
      {segments.map((segment, index) => {
        const key = `seg-${index}`;
        if (segment.kind === "prose") return bubble(<Prose source={segment.text} />, key);
        if (segment.kind === "code") {
          if (segment.lang === "diff") {
            return (
              <div key={key} className="my-1.5 overflow-hidden rounded-card bg-raised el-1">
                <div className="flex h-8 items-center gap-2 border-b border-[var(--line-soft)] px-3">
                  <Icon name="split" size={13} className="text-ink-38" />
                  <span className="font-mono text-xs text-ink-52">diff</span>
                </div>
                <Diff patch={segment.text} lang="ts" className="py-1.5" />
              </div>
            );
          }
          return <CodeBlock key={key} code={segment.text} lang={segment.lang} className="my-1.5" />;
        }
        if (segment.kind === "table") {
          return (
            <div key={key} className="my-1.5 overflow-hidden rounded-card bg-raised el-1">
              <Prose source={segment.text} />
            </div>
          );
        }
        return (
          <div key={key} className="my-1.5 rounded-card bg-raised px-3.5 py-2.5 el-1">
            <Prose source={segment.text} />
          </div>
        );
      })}
    </>
  );
});
