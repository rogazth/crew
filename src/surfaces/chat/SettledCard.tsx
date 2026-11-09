import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { lazy, memo, Suspense, useState } from "react";
import { describeApproval, hasApprovalBody } from "../../lib/approvals";
import type { Block } from "../../lib/blocks";
import { hasBody } from "../../lib/toolDetail";
import { approvalIcon, SETTLED_TILE } from "./approvalIcon";
import { ApprovalTitle } from "./ApprovalTitle";
import { AnsweredQuestions } from "./QuestionCard";
import { ToolBody } from "./ToolBody";

const ApprovalBody = lazy(() => import("./ApprovalBody").then((m) => ({ default: m.ApprovalBody })));

/**
 * A card the user already answered, kept where it was asked. One line that
 * says what came of it, "Edited a.rs" or "Plan rejected". It never folds into
 * "Worked for" or a group's summary, so a decision stays where the reader can
 * find it. It opens only onto something the line does not already say.
 */
export const SettledCard = memo(function SettledCard({ block, marked }: { block: Block; marked: string | null }) {
  const found = marked === block.id ? " crew-found" : "";
  if (block.question) {
    return (
      <div className={found.trim()} data-block={block.id}>
        <AnsweredQuestions block={block} />
      </div>
    );
  }
  return <Decided block={block} found={found} />;
});

function Tile({ icon: Icon, tone }: { icon: LucideIcon; tone: string }) {
  return (
    <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${tone}`}>
      <Icon className="size-4" />
    </span>
  );
}

function Decided({ block, found }: { block: Block; found: string }) {
  const [open, setOpen] = useState(false);
  const approval = block.approval!;
  const title = block.tool?.title ?? block.text;
  const view = describeApproval(approval.name, approval.input, title);
  const ran = block.tool !== undefined && hasBody(block);
  const opens = ran || hasApprovalBody(approval.name, approval.input, block.text);
  const head = (
    <>
      <Tile icon={approvalIcon(view)} tone={SETTLED_TILE} />
      <ApprovalTitle view={view} decided={approval.decided} />
    </>
  );
  if (!opens) {
    return (
      <div className={`crew-settled${found}`} data-block={block.id}>
        <div className="flex min-w-0 items-center gap-2.5">
          {head}
        </div>
      </div>
    );
  }
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={`crew-settled${found}`}
      data-block={block.id}
    >
      <Collapsible.Trigger className="flex w-full min-w-0 items-center gap-2.5 text-left">
        {head}
        <ChevronRightIcon className={`size-3.5 shrink-0 text-icon transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="flex flex-col gap-2.5 pt-3">
          {/* A command's output does not say which command ran; an edit's result already shows the change. */}
          {!ran || view.kind === "shell" ? (
            <Suspense fallback={null}>
              <ApprovalBody name={approval.name} input={approval.input} title={block.text} />
            </Suspense>
          ) : null}
          {ran ? <ToolBody block={block} /> : null}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
