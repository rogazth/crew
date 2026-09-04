import { CheckCircleIcon, CircleIcon } from "@phosphor-icons/react";
import { cloneElement, isValidElement, memo, useMemo, type ComponentProps, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { FileTypeIcon, extensionOf } from "../../chrome/FileTypeIcon";
import { openExternal } from "../../lib/external";
import { groupRuns, isHeadingOnly } from "../../lib/markdownRuns";
import { CodeBlock } from "./CodeBlock";
import { useChatActions } from "./context";
import { CopyButton } from "./CopyButton";
import { SiteIcon } from "./SiteIcon";

type Props = { text: string; streaming?: boolean };

/** `src/lib/tabs.ts`, `README.md`, `./x.css`: a path with an extension and no spaces. */
const PATH_LIKE = /^(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z0-9]{1,8}$/i;

function codeText(children: ReactNode): string {
  return typeof children === "string" ? children : Array.isArray(children) ? children.join("") : String(children ?? "");
}

type CodeProps = ComponentProps<"code"> & { node?: unknown; "data-block"?: unknown };

function Code({ className, children, node: _node, ...rest }: CodeProps) {
  const text = codeText(children);
  if ("data-block" in rest) {
    const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    return <CodeBlock code={text.replace(/\n$/, "")} {...(lang ? { lang } : {})} />;
  }
  if (PATH_LIKE.test(text) && extensionOf(text)) return <FileChip path={text} />;
  return <code className="crew-inline-code">{children}</code>;
}

function FileChip({ path }: { path: string }) {
  const { openPath } = useChatActions();
  const name = path.split("/").pop() ?? path;
  return (
    <button type="button" onClick={() => openPath(path)} title={path} className="crew-file-chip">
      <FileTypeIcon name={name} className="size-3" />
      <span>{path}</span>
    </button>
  );
}

type LinkProps = ComponentProps<"a"> & { node?: unknown };

/** Links leave for the default browser; the URL shows on hover instead of in a dialog. */
function Link({ href, children, node: _node, ...rest }: LinkProps) {
  const url = href && !href.startsWith("streamdown:") ? href : undefined;
  const web = url && /^https?:\/\//i.test(url) ? url : undefined;
  return (
    <a
      {...rest}
      href={url ?? "#"}
      {...(url ? { title: url } : {})}
      data-streamdown="link"
      onClick={(event) => {
        event.preventDefault();
        if (url) openExternal(url);
      }}
    >
      {web ? <SiteIcon url={web} /> : null}
      {children}
    </a>
  );
}

type InputProps = ComponentProps<"input"> & { node?: unknown };

/** A task item's box: the native control can't take the icon shape the list wants. */
function Input({ type, checked, node: _node, ...rest }: InputProps) {
  if (type !== "checkbox") return <input type={type} checked={checked} {...rest} />;
  const Glyph = checked ? CheckCircleIcon : CircleIcon;
  return <Glyph className="crew-md-task" aria-hidden />;
}

const COMPONENTS: Components = {
  a: Link,
  code: Code,
  input: Input,
  // The fence's <pre> only marks its child as a block; the box is CodeBlock's.
  pre: ({ children }) =>
    isValidElement(children) ? cloneElement(children, { "data-block": true } as object) : <>{children}</>,
};

function runClass(kind: "prose" | "wide", text: string): string {
  if (kind === "wide") return "crew-md-wide";
  return isHeadingOnly(text) ? "crew-md-label" : "crew-md-prose";
}

/**
 * Prose sits in a bubble on the left; code, quotes and tables take the column.
 * Each run is its own Streamdown, which also keeps settled runs from re-parsing
 * while the last one streams.
 */
export const Markdown = memo(function Markdown({ text, streaming }: Props) {
  const runs = useMemo(() => groupRuns(text), [text]);
  return (
    <div className="crew-md">
      {runs.map((run, index) => {
        const className = runClass(run.kind, run.text);
        const body = (
          <div className={className}>
            <Streamdown
              className="crew-md-flow"
              controls={false}
              components={COMPONENTS}
              isAnimating={streaming === true && index === runs.length - 1}
            >
              {run.text}
            </Streamdown>
          </div>
        );
        // Only the bubble gets the aside copy; code and diffs carry their own.
        return className === "crew-md-prose" ? (
          <div key={index} className="crew-md-row">
            {body}
            <CopyButton text={run.text.trim()} className="crew-copy crew-copy-aside" />
          </div>
        ) : (
          <div key={index} className="crew-md-row">
            {body}
          </div>
        );
      })}
    </div>
  );
});
