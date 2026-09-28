import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";
import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import { agentLabel } from "../../lib/agentNames";
import type { Block } from "../../lib/blocks";
import type { TodoItem } from "../../lib/protocol";
import { asJson, detailOf, foldLines, splitClip } from "../../lib/toolDetail";
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
function Pre({ head, text, danger }: { head: string; text: string; danger?: boolean }) {
  const { body, dropped } = splitClip(text);
  return (
    <Folded text={body}>
      {(shown) => (
        <div className="crew-code">
          <div className="crew-code-head">
            <span className={danger ? "text-danger" : undefined}>{head}</span>
            <CopyButton text={body} />
          </div>
          <pre className="crew-code-body">
            <code>{shown}</code>
          </pre>
          <Dropped bytes={dropped} />
        </div>
      )}
    </Folded>
  );
}

/** Source, highlighted, folded like any other long payload. */
function Source({ text, lang }: { text: string; lang?: string | undefined }) {
  const { body } = splitClip(text);
  return <Folded text={body}>{(shown) => <CodeBlock code={shown} {...(lang ? { lang } : {})} />}</Folded>;
}

/** A result: JSON laid out and highlighted, anything else as the terminal printed it. */
function Result({ head, text, danger }: { head: string; text: string; danger?: boolean }) {
  const json = asJson(splitClip(text).body);
  if (json) return <Source text={json} lang="json" />;
  return <Pre head={head} text={text} {...(danger ? { danger } : {})} />;
}

function Prose({ text }: { text: string }) {
  return (
    <div className="my-1 rounded-xl px-3 py-2 ring-1 ring-hairline">
      <Suspense fallback={<p className="whitespace-pre-wrap text-[13px] leading-[19px]">{text}</p>}>
        <Markdown text={splitClip(text).body} />
      </Suspense>
    </div>
  );
}

function langProp(path: string): { lang?: string } {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { lang: name.slice(dot + 1) } : {};
}

const TODO_ICON = { completed: CircleCheckIcon, inProgress: CircleDotIcon, pending: CircleIcon } as const;

function Todos({ items }: { items: TodoItem[] }) {
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

/**
 * What the row shows when it is opened. Only the kinds that carry something
 * worth a box get one; `hasBody` in `lib/toolDetail` is the same decision, made
 * before the row offers to open at all.
 */
export const ToolBody = memo(function ToolBody({ block }: { block: Block }) {
  const detail = detailOf(block);
  if (!detail) return null;
  const failed = block.tool?.status === "failed";

  switch (detail.kind) {
    case "command": {
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
    case "file":
      return detail.preview?.trim() ? <Source text={detail.preview} {...langProp(detail.path)} /> : null;
    case "edit": {
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
    case "search":
    case "fetch":
      return detail.output?.trim() ? <Result head="results" text={detail.output} danger={failed} /> : null;
    case "message":
      return <Pre head={`to ${agentLabel(detail.to)}`} text={detail.text} />;
    case "todo":
      return <Todos items={detail.items} />;
    case "agent":
      return (
        <>
          {detail.prompt?.trim() ? <Pre head="asked" text={detail.prompt} /> : null}
          {detail.output?.trim() ? <Prose text={detail.output} /> : null}
        </>
      );
    case "mcp":
      return (
        <>
          {detail.input?.trim() ? <Source text={detail.input} lang="json" /> : null}
          {detail.output?.trim() ? <Result head="result" text={detail.output} danger={failed} /> : null}
        </>
      );
    case "plan":
      return <Prose text={detail.text} />;
    case "output":
      return <Result head="output" text={detail.text} danger={failed} />;
  }
});
