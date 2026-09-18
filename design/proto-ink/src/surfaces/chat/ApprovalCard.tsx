import { useEffect } from "react";
import type { ApprovalDecision, Block } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { threadOf } from "@/lib/source";
import { Icon } from "@/lib/icon";
import { patchFor, relativeOf } from "@/lib/files";
import { useHotApproval } from "./context";
import { Button, Kbd } from "@/ui";
import { DiffBlock } from "@/surfaces/DiffView";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The card says what the call *will* do, not that a call exists: a patch for an
 * edit, the command for a shell call, the raw input otherwise. It is the one
 * thing in the transcript allowed an attention tint, because it is the one thing
 * the transcript is blocked on.
 */
export function ApprovalCard({ block, sessionId }: { block: Block; sessionId: string }) {
  const hot = useHotApproval() === block.id;
  const approval = block.approval;

  const decide = (decision: ApprovalDecision) => {
    if (!approval) return;
    void threadOf(sessionId).approve(approval.requestId, decision);
  };

  useEffect(() => {
    if (!hot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      if (node && (node.tagName === "TEXTAREA" || node.tagName === "INPUT")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        decide("allow");
      } else if (event.key === "Escape") {
        event.preventDefault();
        decide("deny");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!approval) return null;

  const input = approval.input ?? {};
  const filePath = asString(input["file_path"]) ?? asString(input["path"]);
  const command = asString(input["command"]);
  const patch = asString(input["diff"]) ?? (filePath ? patchFor(relativeOf(filePath)) : null);
  const title = block.text || approval.name;

  return (
    <div
      data-block={block.id}
      className={cx(
        "my-1.5 overflow-hidden rounded-card bg-chrome",
        hot
          ? "shadow-[inset_0_0_0_1px_var(--attention-stroke)]"
          : "hairline",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-[var(--attention-fill)] text-[var(--status-attention)]">
          <Icon name="alert" size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-primary">{title}</p>
          <p className="text-micro text-tertiary">
            {approval.name} wants permission{hot ? "" : " · waiting behind another request"}
          </p>
        </div>
      </div>

      <div className="px-3 pb-2">
        {patch ? (
          <DiffBlock patch={patch} />
        ) : command ? (
          <pre className="ink-scroll overflow-x-auto rounded-md bg-canvas px-2.5 py-1.5 hairline">
            <code className="ink-mono whitespace-pre text-primary">{command}</code>
          </pre>
        ) : (
          <pre className="ink-scroll max-h-40 overflow-auto rounded-md bg-canvas px-2.5 py-1.5 hairline">
            <code className="ink-mono whitespace-pre-wrap text-secondary">
              {JSON.stringify(input, null, 2)}
            </code>
          </pre>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--stroke-tertiary)] px-3 py-2">
        <Button size="sm" onClick={() => decide("deny")} trailing={hot ? <Kbd className="ml-1">Esc</Kbd> : undefined}>
          Deny
        </Button>
        <Button size="sm" onClick={() => decide("always")}>
          Always allow
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          tone="primary"
          onClick={() => decide("allow")}
          trailing={hot ? <Kbd className="ml-1 bg-[var(--fill-secondary)]">⏎</Kbd> : undefined}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
