import clsx from "clsx";
import { useEffect } from "react";
import { diffs, type ApprovalDecision, type Block } from "@crew/fixtures";
import { Button, Kbd } from "@/ui";
import { DiffView } from "../DiffView";
import { Code } from "./Code";

const relativeOf = (path: string) => String(path).replace(/^\/Users\/[^/]+\/crew\//, "");

/**
 * The card says what the call *will* do, never just its name. Only the newest
 * open card is hot; a stack of them does not fight over Enter.
 */
export function ApprovalCard({
  block,
  hot,
  onDecide,
}: {
  block: Block;
  hot: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;

  useEffect(() => {
    if (!hot) return;
    const onKey = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      if (node && /^(input|textarea)$/i.test(node.tagName)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        onDecide("allow");
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onDecide("deny");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hot, onDecide]);

  if (!approval) return null;
  const input = approval.input ?? {};
  const command = typeof input.command === "string" ? input.command : null;
  const filePath = typeof input.file_path === "string" ? relativeOf(input.file_path) : null;
  const patch = filePath ? diffs.find((entry) => entry.path === filePath) : undefined;

  return (
    <div
      className={clsx(
        "mt-1 overflow-hidden rounded-[var(--r)] border bg-raised",
        hot ? "border-amber" : "border-rule",
      )}
    >
      <div className="flex items-center gap-2 border-b border-rule px-2 py-1">
        <span className="font-mono text-xs tracking-wide text-amber-ink uppercase">
          Permission
        </span>
        <span className="truncate font-mono text-xs text-ink-3">{approval.name}</span>
        {hot ? <span className="ml-auto font-mono text-xs text-ink-4">hot</span> : null}
      </div>

      <div className="px-2 py-2">
        {command ? (
          <pre className="scroll max-h-[220px] overflow-auto rounded-[var(--r)] border border-rule bg-sunken px-2 py-1 font-mono text-sm whitespace-pre-wrap">
            <Code text={command} lang="bash" />
          </pre>
        ) : patch ? (
          <DiffView
            patch={patch.patch}
            path={patch.path}
            added={patch.added}
            removed={patch.removed}
          />
        ) : filePath ? (
          <p className="font-mono text-sm text-ink-2">
            rewrites <span className="text-accent-ink">{filePath}</span>
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-sm">
            {Object.entries(input).length === 0 ? (
              <p className="text-ink-3">{block.text}</p>
            ) : null}
            {Object.entries(input).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-ink-4">{key}</dt>
                <dd className="truncate text-ink-2">{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-rule px-2 py-1.5">
        <Button variant="ghost" onClick={() => onDecide("deny")} kbd={hot ? <Kbd>Esc</Kbd> : undefined}>
          Deny
        </Button>
        <Button onClick={() => onDecide("always")}>Always allow</Button>
        <Button
          variant="primary"
          className="ml-auto"
          onClick={() => onDecide("allow")}
          kbd={hot ? <Kbd className="border-on-ink/40 text-on-ink">⏎</Kbd> : undefined}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
