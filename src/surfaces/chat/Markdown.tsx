import { CheckCircleIcon, CircleIcon } from "@phosphor-icons/react";
import {
  cloneElement,
  isValidElement,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import { extensionOf } from "../../lib/attachments";
import { BROWSER_CLICK, openLink } from "../../lib/external";
import { groupRuns, isHeadingOnly } from "../../lib/markdownRuns";
import { VEIL_EMA_SEED_MS, veilDurationMs, veilEmaNext } from "../../lib/veil";
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

/** Links open per the browser setting; the URL shows on hover instead of in a dialog. */
function Link({ href, children, node: _node, ...rest }: LinkProps) {
  // A footnote's ref and backref are `#ids` into this same message, not the web.
  const anchor = href?.startsWith("#") ? href.slice(1) : undefined;
  const url = href && anchor === undefined && !href.startsWith("streamdown:") ? href : undefined;
  const web = url && /^https?:\/\//i.test(url) ? url : undefined;
  const { prefs } = useBrowserPrefs();
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
  const last = runs.length - 1;
  const host = useVeilCadence(text, streaming === true);
  return (
    <div ref={host} className="crew-md">
      {runs.map((run, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- runs only grow at the end while streaming; a content key would remount every chunk
        <MarkdownRun
          key={index}
          kind={run.kind}
          text={run.text}
          veiled={streaming === true}
          animating={streaming === true && index === last}
        />
      ))}
    </div>
  );
});

/**
 * Stable: a new object here would rebuild streamdown's timeline mid-turn and
 * re-fade the whole message, so the length rides a CSS variable instead.
 * Streamdown settles a word's fade as soon as the next token lands; the rule
 * below overrides that duration, which is what keeps several chunks dissolving
 * at once instead of each one snapping after a frame.
 */
const VEIL = { animation: "fadeIn", sep: "word", stagger: 28, maxBacklogMs: 320 } as const;

/**
 * Times how fast the text is arriving and hands the fade length to the CSS
 * below as a variable on the turn's root. It is written straight to the node
 * rather than kept in state: the cadence is a property of the paint, and a
 * render per token to carry it would cost more than the fade is worth.
 */
function useVeilCadence(text: string, streaming: boolean) {
  const host = useRef<HTMLDivElement>(null);
  const seen = useRef({ text: "", at: 0, ema: VEIL_EMA_SEED_MS });
  useLayoutEffect(() => {
    const state = seen.current;
    if (streaming && text !== state.text) {
      const now = performance.now();
      if (state.at !== 0 && text.startsWith(state.text)) {
        state.ema = veilEmaNext(state.ema, now - state.at);
      }
      state.at = now;
      state.text = text;
    }
    host.current?.style.setProperty("--crew-veil-ms", `${veilDurationMs(state.ema)}ms`);
  }, [text, streaming]);
  return host;
}

/**
 * A turn re-splits its whole text on every token, so every settled run comes
 * back with the same string. Memoising per run is what keeps Streamdown from
 * re-parsing the finished paragraphs behind the one still arriving.
 */
const MarkdownRun = memo(function MarkdownRun({
  kind,
  text,
  veiled,
  animating,
}: {
  kind: "prose" | "wide";
  text: string;
  veiled: boolean;
  animating: boolean;
}) {
  const className = runClass(kind, text);
  const body = (
    <div className={className}>
      <Streamdown
        className="crew-md-flow"
        controls={false}
        components={COMPONENTS}
        isAnimating={animating}
        {...(veiled ? { animated: VEIL } : {})}
      >
        {text}
      </Streamdown>
    </div>
  );
  // Only the bubble gets the aside copy; code and diffs carry their own.
  return (
    <div className="crew-md-row">
      {body}
      {className === "crew-md-prose" && (
        <CopyButton text={text.trim()} className="crew-copy crew-copy-aside" />
      )}
    </div>
  );
});
