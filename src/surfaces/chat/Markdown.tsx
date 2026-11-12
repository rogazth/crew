import { CircleCheckIcon, CircleIcon } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  useState,
  type ComponentProps,
  type Ref,
  type ReactNode,
} from "react";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, useIsCodeFenceIncomplete, type Components, type ControlsConfig, type StreamdownProps } from "streamdown";
import "streamdown/styles.css";
import { FileRef } from "../../chrome/FileRef";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import { useImageSrc } from "../../hooks/useImageSrc";
import { attachedFrom, extensionOf, imageMime } from "../../lib/attachments";
import type { AttachedFile } from "../../lib/blocks";
import { Lightbox } from "./Attachments";
import { BROWSER_CLICK, openLink } from "../../lib/external";
import { isPathLike, localPath, namedDirs } from "../../lib/localLink";
import { fenceTitle, remarkAlerts } from "../../lib/markdown/alerts";
import { groupRuns, isHeadingOnly } from "../../lib/markdownRuns";
import { Blockquote } from "./Alert";
import { CodeBlock } from "./CodeBlock";
import { useChatActions } from "./context";
import { SiteIcon } from "./SiteIcon";
import { MessageDirs, useFileOnDisk } from "./useFileOnDisk";

type Props = { text: string; streaming?: boolean };

function codeText(children: ReactNode): string {
  return typeof children === "string" ? children : Array.isArray(children) ? children.join("") : String(children ?? "");
}

/** `metastring`: the fence's info string past its language, which streamdown's `codeMeta` puts on the element. */
type CodeProps = ComponentProps<"code"> & { node?: unknown; metastring?: string; "data-block"?: unknown };

function Code({ className, children, node: _node, metastring, ...rest }: CodeProps) {
  const text = codeText(children);
  if ("data-block" in rest) return <Fence code={text} className={className} meta={metastring} />;
  if (isPathLike(text) && extensionOf(text)) return <InlineFile path={text}>{children}</InlineFile>;
  return <code className="crew-inline-code" data-inline-code>{children}</code>;
}

/**
 * A fenced block. Streamdown knows whether the fence is still open, which is
 * what keeps the highlighter and the diagram renderer off a half-arrived block.
 */
function Fence({ code, className, meta }: { code: string; className: string | undefined; meta: string | undefined }) {
  const incomplete = useIsCodeFenceIncomplete();
  const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
  const title = fenceTitle(meta);
  return (
    <CodeBlock
      code={code.replace(/\n$/, "")}
      {...(lang ? { lang } : {})}
      {...(title ? { title } : {})}
      {...(incomplete ? { streaming: true } : {})}
    />
  );
}

/** A chip only for a file that is there: a name that opens nothing stays code. */
function InlineFile({ path, children }: { path: string; children: ReactNode }) {
  const { openPath } = useChatActions();
  const { ref, file } = useFileOnDisk(path);
  const [image, setImage] = useState<string | null>(null);
  // An image opens in the viewer over the chat, never in a tab of its own.
  if (file)
    return (
      <>
        <FileRef path={path} full onOpen={() => (imageMime(file) ? setImage(file) : openPath(file))} />
        {image && <Lightbox images={[attachedFrom(image)]} index={0} onIndex={() => {}} onClose={() => setImage(null)} />}
      </>
    );
  return (
    <code ref={ref} className="crew-inline-code" data-inline-code>
      {children}
    </code>
  );
}

type LinkProps = ComponentProps<"a"> & { node?: unknown };

/** Links open per the browser setting; the URL shows on hover instead of in a dialog. */
function Link({ href, children, node: _node, ...rest }: LinkProps) {
  const { openPath } = useChatActions();
  // A footnote's ref and backref are `#ids` into this same message, not the web.
  const anchor = href?.startsWith("#") ? href.slice(1) : undefined;
  const file = localPath(href);
  const { ref: probe, file: found } = useFileOnDisk(file ?? "");
  const url = href && anchor === undefined && !href.startsWith("streamdown:") ? href : undefined;
  const web = url && /^https?:\/\//i.test(url) ? url : undefined;
  const { prefs } = useBrowserPrefs();
  if (file && !found) return <span ref={probe}>{children}</span>;
  if (file && found) {
    return (
      <a
        {...rest}
        href={href}
        title={found}
        data-streamdown="link"
        onClick={(event) => {
          event.preventDefault();
          openPath(found);
        }}
      >
        <FileTypeIcon name={file.split("/").pop() ?? file} className="crew-site-icon" />
        {children}
      </a>
    );
  }
  const title = web && prefs.openLinksInCrew ? `${web}\n${BROWSER_CLICK}-click to open in your browser` : url;
  return (
    <a
      {...rest}
      href={href ?? "#"}
      {...(title ? { title } : {})}
      data-streamdown="link"
      onClick={(event) => {
        event.preventDefault();
        if (url) openLink(url, event);
        else if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: "center" });
      }}
    >
      {web ? <SiteIcon url={web} /> : null}
      {children}
    </a>
  );
}

type ImgProps = ComponentProps<"img"> & { node?: unknown };

/**
 * `![shot](/tmp/shots/a.png)`: an image on the agent's machine, read through
 * the app like an attachment, so it shows wherever the window was loaded
 * from. Every one is the same box, whatever its shape, and opens the viewer
 * on every image the message shows, in order.
 */
function MarkdownImage({ src, alt }: ImgProps) {
  const path = typeof src === "string" ? localPath(src) : null;
  const { ref, file } = useFileOnDisk(path ?? "");
  const data = useImageSrc(file ?? "");
  const [gallery, setGallery] = useState<{ images: AttachedFile[]; index: number } | null>(null);
  const label = alt || file?.split("/").pop() || "image";
  if (!path || file === null) return <span>{alt || src}</span>;
  return (
    <>
      <button
        ref={ref as unknown as Ref<HTMLButtonElement>}
        type="button"
        title={file ?? path}
        aria-label={`Open ${label}`}
        className="crew-md-image"
        {...(file ? { "data-md-image": file } : {})}
        onClick={(event) => {
          if (!file) return;
          const shown = [...(event.currentTarget.closest(".crew-md")?.querySelectorAll<HTMLElement>("[data-md-image]") ?? [])];
          const paths = [...new Set(shown.map((el) => el.dataset.mdImage!))];
          setGallery({ images: paths.map((p) => attachedFrom(p)), index: Math.max(0, paths.indexOf(file)) });
        }}
      >
        {data && <img src={data} alt={label} draggable={false} />}
      </button>
      {gallery && (
        <Lightbox
          images={gallery.images}
          index={gallery.index}
          onIndex={(index) => setGallery({ ...gallery, index })}
          onClose={() => setGallery(null)}
        />
      )}
    </>
  );
}

type InputProps = ComponentProps<"input"> & { node?: unknown };

/** A task item's box: the native control can't take the icon shape the list wants. */
function Input({ type, checked, node: _node, ...rest }: InputProps) {
  if (type !== "checkbox") return <input type={type} checked={checked} {...rest} />;
  const Glyph = checked ? CircleCheckIcon : CircleIcon;
  return <Glyph className="crew-md-task" aria-hidden />;
}

const COMPONENTS: Components = {
  a: Link,
  blockquote: Blockquote,
  code: Code,
  img: MarkdownImage,
  input: Input,
  // The fence's <pre> only marks its child as a block; the box is CodeBlock's.
  pre: ({ children }) =>
    isValidElement(children) ? cloneElement(children, { "data-block": true } as object) : <>{children}</>,
};

/** Streamdown's own plugins, then callouts. Module-level: a new array would re-parse every run. */
const REMARK = [...Object.values(defaultRemarkPlugins), remarkAlerts];
/**
 * Streamdown's sanitizer keeps a blockquote's `cite` and nothing else, which
 * would strip the kind `remarkAlerts` put on it. Its schema, plus those two.
 */
type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];
const REHYPE = Object.entries(defaultRehypePlugins).map(([name, plugin]) => {
  if (name !== "sanitize" || !Array.isArray(plugin)) return plugin;
  const [sanitize, schema] = plugin as [unknown, { attributes?: Record<string, unknown[]> }];
  const attributes = schema.attributes ?? {};
  return [
    sanitize,
    { ...schema, attributes: { ...attributes, blockquote: [...(attributes.blockquote ?? []), "dataAlert", "dataAlertTitle"] } },
  ] as Pluggable;
});
/** `$$…$$` only: a lone `$` is a price far more often than it is maths. */
const PLUGINS = { math: createMathPlugin({ singleDollarTextMath: false }) };
/** Code and diagrams bring their own controls. A table's copy control has nowhere to sit. */
const CONTROLS: ControlsConfig = {
  table: false,
  code: false,
  mermaid: false,
  image: false,
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
  // Joined, so a streaming reply that names no new folder keeps the same list.
  const dirsKey = useMemo(() => namedDirs(text).join("\n"), [text]);
  const dirs = useMemo(() => (dirsKey ? dirsKey.split("\n") : []), [dirsKey]);
  const last = runs.length - 1;
  return (
    <MessageDirs value={dirs}>
    <div className="crew-md">
      {runs.map((run, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- runs only grow at the end while streaming; a content key would remount every chunk
        <MarkdownRun
          key={index}
          kind={run.kind}
          text={run.text}
          animating={streaming === true && index === last}
        />
      ))}
    </div>
    </MessageDirs>
  );
});

/**
 * A turn re-splits its whole text on every token, so every settled run comes
 * back with the same string. Memoising per run is what keeps Streamdown from
 * re-parsing the finished paragraphs behind the one still arriving.
 */
const MarkdownRun = memo(function MarkdownRun({
  kind,
  text,
  animating,
}: {
  kind: "prose" | "wide";
  text: string;
  animating: boolean;
}) {
  const className = runClass(kind, text);
  const body = (
    <div className={className}>
      <Streamdown
        className="crew-md-flow"
        controls={CONTROLS}
        components={COMPONENTS}
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        plugins={PLUGINS}
        isAnimating={animating}
      >
        {text}
      </Streamdown>
    </div>
  );
  // The reply is copied whole from its footer; code and diffs carry their own.
  return <div className="crew-md-row">{body}</div>;
});
