import { memo } from "react";
import type { Block } from "../../lib/blocks";
import { detailOf, splitClip } from "../../lib/toolDetail";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";

/** Terminal output is not source: a plain box, no grammar, no worker. */
function Pre({ head, text, danger }: { head: string; text: string; danger?: boolean }) {
  const { body, dropped } = splitClip(text);
  return (
    <div className="crew-code">
      <div className="crew-code-head">
        <span className={danger ? "text-danger" : undefined}>{head}</span>
        <CopyButton text={body} />
      </div>
      <pre className="crew-code-body">
        <code>{body}</code>
      </pre>
      {dropped === null ? null : (
        <p className="border-t border-hairline px-3 py-1 text-[11px] text-placeholder">
          {dropped.toLocaleString()} more bytes not kept
        </p>
      )}
    </div>
  );
}

function langProp(path: string): { lang?: string } {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { lang: name.slice(dot + 1) } : {};
}

/**
 * What the row shows when it is opened. Only the kinds that carry something
 * worth a box get one; `hasBody` in `lib/toolDetail` is the same decision, made
 * before the row offers to open at all.
 */
export const ToolBody = memo(function ToolBody({ block }: { block: Block }) {
  const detail = detailOf(block);
  if (!detail) return null;

  switch (detail.kind) {
    case "command": {
      const failed = detail.exitCode !== undefined && detail.exitCode !== 0;
      return (
        <>
          {detail.command.includes("\n") ? <Pre head="command" text={detail.command} /> : null}
          {detail.output?.trim() ? (
            <Pre
              head={detail.exitCode === undefined ? "output" : `exit ${detail.exitCode}`}
              text={detail.output}
              danger={failed}
            />
          ) : null}
        </>
      );
    }
    case "file":
      return detail.preview?.trim() ? (
        <CodeBlock code={splitClip(detail.preview).body} {...langProp(detail.path)} />
      ) : null;
    case "message":
      return <Pre head={`to ${detail.to}`} text={detail.text} />;
    case "output":
      return <Pre head="output" text={detail.text} />;
    default:
      return null;
  }
});
