import { cloneElement, isValidElement, memo, type ComponentProps, type ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { FileTypeIcon, extensionOf } from "../../chrome/FileTypeIcon";
import { CodeBlock } from "./CodeBlock";
import { useChatActions } from "./context";

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

const COMPONENTS: Components = {
  code: Code,
  // The fence's <pre> only marks its child as a block; the box is CodeBlock's.
  pre: ({ children }) =>
    isValidElement(children) ? cloneElement(children, { "data-block": true } as object) : <>{children}</>,
};

/** Streaming markdown, styled with Cursor's 13/18 and ink-mixed surfaces. */
export const Markdown = memo(function Markdown({ text, streaming }: Props) {
  return (
    <Streamdown
      className="crew-md"
      controls={false}
      components={COMPONENTS}
      isAnimating={streaming === true}
    >
      {text}
    </Streamdown>
  );
});
