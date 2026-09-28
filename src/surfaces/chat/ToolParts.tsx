import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import type { TodoItem, ToolDetail } from "../../lib/protocol";
import { asJson, foldLines, splitClip } from "../../lib/toolDetail";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { Diff } from "./DiffView";

/** streamdown is half a megabyte; a subagent's report is the only tool body that needs it. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/**
 * A long payload folds to its first lines behind a count. Opening it is a
 * choice made about this row only, so the state lives here.
 */
function Folded({ text, children }: { text: string; children: (shown: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  const { head, hidden } = foldLines(text);
  return (
    <>
      {children(all ? text : head)}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setAll((open) => !open)}
          className="-mt-1 mb-1 px-1 text-[11px] leading-4 text-placeholder transition-colors hover:text-text"
        >
          {all ? "Show less" : `Show ${hidden.toLocaleString()} more lines`}
        </button>
      ) : null}
    </>
  );
}

function Dropped({ bytes }: { bytes: number | null }) {
  if (bytes === null) return null;
  return (
    <p className="border-t border-hairline px-3 py-1 text-[11px] text-placeholder">
      {bytes.toLocaleString()} more bytes not kept
    </p>
  );
}

/** Terminal output is not source: a plain box, no grammar, no worker. */
export function Pre({ head, text, danger, wrap }: { head: string; text: string; danger?: boolean; wrap?: boolean }) {
  const { body, dropped } = splitClip(text);
  return (
    <Folded text={body}>
      {(shown) => (
        <div className="crew-code">
          <div className="crew-code-head">
            <span className={danger ? "text-danger" : undefined}>{head}</span>
            <CopyButton text={body} />
          </div>
          <pre className={`crew-code-body${wrap ? " is-wrapped" : ""}`}>
            <code>{shown}</code>
          </pre>
          <Dropped bytes={dropped} />
        </div>
      )}
    </Folded>
  );
}

/** Source, highlighted, folded like any other long payload. */
export function Source({ text, lang }: { text: string; lang?: string | undefined }) {
  const { body } = splitClip(text);
  return <Folded text={body}>{(shown) => <CodeBlock code={shown} {...(lang ? { lang } : {})} />}</Folded>;
}

/** A result: JSON laid out and highlighted, anything else as the terminal printed it. */
export function Result({ head, text, danger }: { head: string; text: string; danger?: boolean }) {
  const json = asJson(splitClip(text).body);
  if (json) return <Source text={json} lang="json" />;
  return <Pre head={head} text={text} {...(danger ? { danger } : {})} />;
}

export function Prose({ text }: { text: string }) {
  return (
    <div className="my-1 rounded-xl px-3 py-2 ring-1 ring-hairline">
      <Suspense fallback={<p className="whitespace-pre-wrap text-[13px] leading-[19px]">{text}</p>}>
        <Markdown text={splitClip(text).body} />
      </Suspense>
    </div>
  );
}


const TODO_ICON = { completed: CircleCheckIcon, inProgress: CircleDotIcon, pending: CircleIcon } as const;

export function Todos({ items }: { items: TodoItem[] }) {
  return (
    <ul className="flex flex-col gap-1 py-1 text-[13px] leading-[18px]">
      {items.map((item, index) => {
        const Glyph = TODO_ICON[item.status];
        return (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a checklist is restated whole on every call; its order is its identity
          <li key={index} className="flex items-start gap-2">
            <Glyph
              className={`mt-px size-3.5 shrink-0 ${item.status === "pending" ? "text-placeholder" : item.status === "inProgress" ? "text-accent" : "text-icon"}`}
            />
            <span
              className={
                item.status === "completed"
                  ? "text-text-muted line-through decoration-text-muted/50"
                  : item.status === "inProgress"
                    ? "text-text"
                    : "text-text-muted"
              }
            >
              {item.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function CommandBody({ detail, failed }: { detail: Extract<ToolDetail, { kind: "command" }>; failed: boolean }) {
  const exitFailed = detail.exitCode !== undefined && detail.exitCode !== 0;
  return (
    <>
      {detail.command.includes("\n") ? <Source text={detail.command} lang="bash" /> : null}
      {detail.output?.trim() ? (
        <Pre
          head={detail.exitCode === undefined ? "output" : `exit ${detail.exitCode}`}
          text={detail.output}
          danger={exitFailed || failed}
        />
      ) : null}
    </>
  );
}

export function EditBody({ detail }: { detail: Extract<ToolDetail, { kind: "edit" }> }) {
  const name = detail.path.split("/").pop() ?? detail.path;
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {detail.hunks?.map((hunk, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a call's hunks never reorder
        <Diff key={index} name={name} before={hunk.before} after={hunk.after} />
      ))}
    </div>
  );
}

/** Two optional parts, each shown only when it has something in it. */
export function Pair({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <>
      {first}
      {second}
    </>
  );
}

/**
 * A page the agent fetched. Claude and cursor hand back markdown (Claude's is
 * its own summary of the page), opencode the raw HTML: markdown reads as
 * prose, HTML as source that wraps instead of running off the side.
 */
export function FetchBody({ text, failed }: { text: string; failed: boolean }) {
  if (/^\s*<(?:!doctype|html)\b/i.test(text)) return <Pre head="page" text={text} wrap {...(failed ? { danger: true } : {})} />;
  return <Prose text={text} />;
}
