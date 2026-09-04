import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import { memo, useEffect, useMemo, useRef } from "react";
import type { ApprovalDecision, Block } from "../../lib/blocks";
import { THEME } from "../../lib/highlighting";
import { CodeBlock } from "./CodeBlock";

type Props = {
  block: Block;
  /** Only the newest open card takes Enter and Escape. */
  hot?: boolean;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
};

const DIFF_OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  diffStyle: "unified" as const,
  overflow: "scroll" as const,
};

const EDIT = /^(edit|multiedit|write|notebookedit)$/i;

function str(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The call, shown as what it will do: a diff for an edit, the command for a
 * shell call, the raw input for anything else. Allow is the default action.
 */
export const ApprovalCard = memo(function ApprovalCard({ block, hot = false, onApprove }: Props) {
  const approval = block.approval;
  const requestId = approval?.requestId;
  const name = approval?.name ?? "";
  const input = approval?.input;
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hot) card.current?.focus();
  }, [hot]);

  useEffect(() => {
    if (!hot || requestId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        onApprove(requestId, "allow");
      } else if (event.key === "Escape") {
        event.preventDefault();
        onApprove(requestId, "deny");
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hot, requestId, onApprove]);

  if (requestId == null) return null;

  return (
    <div ref={card} tabIndex={-1} className="crew-card my-1.5 outline-none">
      <p className="text-[13px] leading-[18px] text-text-muted">{headline(name, input, block.text)}</p>
      <Body name={name} input={input} />
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={() => onApprove(requestId, "deny")} className="crew-btn">
          Deny
        </button>
        <button type="button" onClick={() => onApprove(requestId, "always")} className="crew-btn">
          Always allow
        </button>
        <button type="button" onClick={() => onApprove(requestId, "allow")} className="crew-btn crew-btn-primary">
          Allow
        </button>
      </div>
    </div>
  );
});

function headline(name: string, input: Record<string, unknown> | undefined, title: string): string {
  const path = str(input, "file_path") ?? str(input, "path");
  const leaf = path?.split("/").pop();
  if (EDIT.test(name)) return leaf ? `Wants to edit ${leaf}` : "Wants to edit a file";
  if (/^bash$/i.test(name)) return "Wants to run a command";
  if (/^read$/i.test(name)) return leaf ? `Wants to read ${leaf}` : "Wants to read a file";
  return `Wants to use ${name}: ${title}`;
}

function Body({ name, input }: { name: string; input: Record<string, unknown> | undefined }) {
  const command = str(input, "command");
  if (command) return <CodeBlock code={command} lang="bash" />;
  const path = str(input, "file_path") ?? str(input, "path");
  if (EDIT.test(name) && path) {
    const before = str(input, "old_string") ?? "";
    const after = str(input, "new_string") ?? str(input, "content") ?? "";
    if (before || after) return <Diff path={path} before={before} after={after} />;
  }
  if (input && Object.keys(input).length > 0) {
    return <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" />;
  }
  return null;
}

function Diff({ path, before, after }: { path: string; before: string; after: string }) {
  const name = path.split("/").pop() ?? path;
  // A snippet is not a file; without the trailing newline every hunk warns about it.
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        before ? { name, contents: before.endsWith("\n") ? before : `${before}\n` } : null,
        after ? { name, contents: after.endsWith("\n") ? after : `${after}\n` } : null,
      ),
    [name, before, after],
  );
  return <FileDiff fileDiff={fileDiff} options={DIFF_OPTIONS} disableWorkerPool className="crew-diff" />;
}
