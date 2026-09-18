import { useEffect } from "react";
import { diffs, shortPath, type ApprovalDecision, type Block } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Diff } from "../DiffView";
import { isTypingTarget, useChat } from "./context";

const DECIDED_LABEL: Record<ApprovalDecision, string> = {
  allow: "Allowed",
  always: "Always allowed",
  deny: "Denied",
};

export function ApprovalCard({ block }: { block: Block }) {
  const { runtime, hotApproval } = useChat();
  const { openFile } = useStore();
  const approval = block.approval;
  const hot = approval !== undefined && approval.requestId === hotApproval;

  useEffect(() => {
    if (!hot || !approval) return;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        runtime.approve(approval.requestId, "allow");
      } else if (event.key === "Escape") {
        event.preventDefault();
        runtime.approve(approval.requestId, "deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hot, approval, runtime]);

  if (!approval) return null;

  if (approval.decided) {
    const denied = approval.decided === "deny";
    return (
      <div className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1">
        <Icon
          name={denied ? "circleX" : "circleCheck"}
          size={13}
          className={denied ? "text-[var(--danger)]" : "text-[var(--ok)]"}
        />
        <span className={cx("min-w-0 truncate font-mono text-[12.5px] text-ink-52", denied && "line-through")}>
          {block.text}
        </span>
        <span className="shrink-0 text-xs text-ink-38">{DECIDED_LABEL[approval.decided]}</span>
      </div>
    );
  }

  const input = approval.input ?? {};
  const path = typeof input.file_path === "string" ? input.file_path : null;
  const command = typeof input.command === "string" ? input.command : null;
  const patch = path ? diffs.find((entry) => path.endsWith(entry.path)) : undefined;

  return (
    <div
      className={cx(
        "w-full overflow-hidden rounded-card bg-raised el-2",
        hot && "shadow-[var(--e2),0_0_0_3px_var(--accent-soft)]",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-soft)] px-3.5 py-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-chip bg-warn-soft text-[var(--warn)]">
          <Icon name="circleAlert" size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-ink">Permission needed</p>
          <p className="truncate text-sm text-ink-52">{block.text}</p>
        </div>
      </div>

      <div className="border-b border-[var(--line-soft)]">
        {patch ? (
          <Diff patch={patch.patch} lang="ts" className="max-h-[300px] overflow-auto py-1.5" />
        ) : command ? (
          <pre className="scroller overflow-x-auto bg-code-bg px-3.5 py-2.5 font-mono text-code text-code-ink">
            <span className="mr-2 select-none text-ink-38">$</span>
            {command}
          </pre>
        ) : path ? (
          <button
            type="button"
            onClick={() => openFile(path.replace("/Users/you/crew/", ""))}
            className="flex w-full items-center gap-2 px-3.5 py-3 text-left hover:bg-sunken"
          >
            <Icon name="fileCode" size={15} className="shrink-0 text-ink-38" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{shortPath(path)}</span>
            <span className="shrink-0 text-sm text-ink-52">will be rewritten</span>
            <Icon name="arrowUpRight" size={13} className="shrink-0 text-ink-38" />
          </button>
        ) : Object.keys(input).length > 0 ? (
          <pre className="scroller max-h-[220px] overflow-auto bg-code-bg px-3.5 py-2.5 font-mono text-code text-code-ink">
            {JSON.stringify(input, null, 2)}
          </pre>
        ) : (
          <p className="px-3.5 py-3 text-base text-ink-52">
            The provider sent no arguments with this request. Allowing it runs{" "}
            <span className="font-mono text-sm text-ink">{approval.name}</span> as the agent asked.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => runtime.approve(approval.requestId, "deny")}
          trailing={hot ? <Kbd>Esc</Kbd> : undefined}
        >
          Deny
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="default" onClick={() => runtime.approve(approval.requestId, "always")}>
          Always allow
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => runtime.approve(approval.requestId, "allow")}
          trailing={hot ? <Kbd tone="on-accent">⏎</Kbd> : undefined}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
