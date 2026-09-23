import { agentLabel } from "../../lib/agentNames";
import { memo } from "react";
import type { Block } from "../../lib/blocks";
import { commandBoxes, langOf } from "../../lib/toolBody";
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
      const { command, output } = commandBoxes(detail);
      return (
        <>
          {command ? <Pre head={command.head} text={command.text} /> : null}
          {output ? <Pre head={output.head} text={output.text} danger={output.danger} /> : null}
        </>
      );
    }
    case "file": {
      const lang = langOf(detail.path);
      return detail.preview?.trim() ? (
        <CodeBlock code={splitClip(detail.preview).body} {...(lang !== undefined ? { lang } : {})} />
      ) : null;
    }
    case "message":
      return <Pre head={`to ${agentLabel(detail.to)}`} text={detail.text} />;
    case "output":
      return <Pre head="output" text={detail.text} />;
    default:
      return null;
  }
});
