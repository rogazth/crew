import clsx from "clsx";
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { store } from "@/lib/store";
import { knownPath } from "@/lib/files";
import { CodeBlock } from "./Code";
import { DiffView } from "../DiffView";

const PATH = /(?:[\w.-]+\/)+[\w.-]+/g;

const isPath = knownPath;

/** A path in prose is a door. Clicking it opens the file in a tab. */
function PathChip({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => store.openFile(path)}
      title={`Open ${path}`}
      className="rounded-[var(--r)] border border-rule bg-sunken px-1 font-mono text-sm text-accent-ink hover:border-accent"
    >
      {path}
    </button>
  );
}

/** Text nodes get scanned once for known paths; code and links are left alone. */
function withPaths(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of children.matchAll(PATH)) {
      const at = match.index ?? 0;
      if (!isPath(match[0])) continue;
      if (at > last) parts.push(children.slice(last, at));
      parts.push(<PathChip key={`${at}-${match[0]}`} path={match[0]} />);
      last = at + match[0].length;
    }
    if (parts.length === 0) return children;
    if (last < children.length) parts.push(children.slice(last));
    return parts;
  }
  if (Array.isArray(children)) return children.map((child, index) => <Slot key={index}>{withPaths(child)}</Slot>);
  return children;
}

function Slot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function hostOf(href: string): string {
  try {
    return new URL(href).host.replace(/^www\./, "");
  } catch {
    return href;
  }
}

const components: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-1 text-xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-1 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1 text-md font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 font-mono text-sm tracking-wide text-ink-2 uppercase first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => <h5 className="mt-2 mb-1 text-md font-semibold text-ink-2">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 text-sm font-semibold text-ink-3">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{withPaths(children)}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-3 line-through">{children}</del>,
  hr: () => <hr className="my-4 border-t border-rule" />,
  a: ({ href, children }) => {
    // A footnote back-reference is an anchor, not a site; it gets no mark.
    const external = /^https?:/.test(href ?? "");
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        className="inline-flex items-baseline gap-1 text-accent-ink underline decoration-from-font underline-offset-2"
      >
        {external ? (
          <span
            aria-hidden
            className="inline-grid size-[12px] shrink-0 translate-y-[1px] place-items-center rounded-[2px] bg-accent-wash font-mono text-[7px] leading-none text-accent-ink"
          >
            {hostOf(href ?? "").slice(0, 2)}
          </span>
        ) : null}
        {children}
      </a>
    );
  },
  ul: ({ children }) => (
    <ul className="my-2 flex list-disc flex-col gap-1 pl-5 marker:text-ink-4">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:font-mono marker:text-sm marker:text-ink-4">
      {children}
    </ol>
  ),
  li: ({ children, className }) => (
    <li
      className={clsx(
        "marker:font-mono marker:text-ink-4",
        className?.includes("task-list-item") && "-ml-5 flex list-none items-baseline gap-2",
      )}
    >
      {withPaths(children)}
    </li>
  ),
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <span
        aria-hidden
        className={clsx(
          "inline-grid size-[12px] shrink-0 translate-y-[1px] place-items-center rounded-[var(--r)] border font-mono text-[9px] leading-none",
          checked ? "border-green bg-green-wash text-green-ink" : "border-rule-strong text-transparent",
        )}
      >
        ✓
      </span>
    ) : null,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-rule-strong pl-3 text-ink-2">{children}</blockquote>
  ),
  table: ({ children }) => (
    // A wide table scrolls inside its own box; it never widens the log column.
    <div className="scroll my-2 overflow-x-auto rounded-[var(--r)] border border-rule">
      <table className="w-full border-collapse font-mono text-sm whitespace-nowrap">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-raised">{children}</thead>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-rule px-2 py-1 text-left font-normal tracking-wide text-ink-3 uppercase"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-rule px-2 py-1 text-ink-2 last:border-b-0">
      {children}
    </td>
  ),
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : ""}
      alt={alt ?? ""}
      className="my-2 max-w-full rounded-[var(--r)] border border-rule"
    />
  ),
  sup: ({ children }) => <sup className="font-mono text-xs text-accent-ink">{children}</sup>,
  section: ({ children, className }) => (
    <section
      className={
        className?.includes("footnotes")
          ? "mt-4 border-t border-rule pt-2 text-sm text-ink-3 [&_h2]:sr-only [&_ol]:pl-4 [&_p]:my-0"
          : className
      }
    >
      {children}
    </section>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const language = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? null;
    if (!language && !text.includes("\n")) {
      const value = text.replace(/\n$/, "");
      if (isPath(value)) return <PathChip path={value} />;
      return (
        <code className="rounded-[var(--r)] bg-sunken px-1 font-mono text-sm text-ink">{value}</code>
      );
    }
    if (language === "diff") {
      return <DiffView patch={text.replace(/\n$/, "")} className="my-2" path="patch" />;
    }
    return <CodeBlock code={text} lang={language} />;
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
      className={clsx(
        "text-md leading-[var(--lh-md)] text-ink-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
