import { memo, useEffect, useState } from "react";
import {
  FOLD_AT,
  activityDigest,
  buildActivity,
  clock,
  glyphKind,
  hasBody,
  isOpen,
  phaseFailed,
  phaseLabel,
  phaseOpen,
  summarize,
  toolLine,
  type ActivityItem,
  type Block,
  type Phase,
} from "@crew/fixtures";
import { CREW_GLYPH, crewDigest, crewLineOf, crewPhaseGlyph, crewPhaseLabel } from "@/lib/crewPhase";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Pulse } from "@/ui/Pulse";
import { Tip } from "@/ui/Tooltip";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ToolBody } from "./ToolBody";

const KIND_GLYPH: Record<string, GlyphName> = {
  command: "terminal",
  file: "fileText",
  edit: "pencil",
  search: "search",
  fetch: "globe",
  message: "users",
  output: "list",
};

const PHASE_GLYPH: Record<Phase["kind"], GlyphName> = {
  edit: "pencil",
  research: "search",
  run: "terminal",
  other: "wrench",
};

/** Folded: a chip. Expanded: a card with a header row and the output. */
const ToolRow = memo(function ToolRow({ block }: { block: Block }) {
  const { sessions, openSession } = useStore();
  const resolve = useResolveAgent();
  const line = toolLine(block, resolve);
  const crew = crewLineOf(block, resolve);
  // The captured `create_agent` answers with a daemon uuid, not the fixture's
  // session id, so the link resolves by name — which is what the row shows.
  const target = crew?.peerName ? sessions.find((session) => session.name === crew.peerName) : undefined;
  const body = hasBody(block);
  const pending = block.tool?.status === "pending";
  const [open, setOpen] = useState(false);
  const glyph = crew ? CREW_GLYPH[crew.kind] : (KIND_GLYPH[glyphKind(block) ?? ""] ?? "wrench");
  const interrupted = block.tool?.status === "interrupted";

  const head = (
    <>
      {crew?.peerName ? (
        <Avatar seed={crew.peerName} size={16} className="shrink-0" />
      ) : (
        <Icon name={glyph} size={13} className={cx("shrink-0", line.failed ? "text-[var(--danger)]" : "text-ink-38")} />
      )}
      <span
        className={cx(
          "min-w-0 flex-1 truncate text-left",
          line.mono && "font-mono text-[12.5px]",
          line.failed ? "text-[var(--danger)]" : "text-ink-70",
          interrupted && "line-through",
        )}
      >
        {line.text}
      </span>
      {line.suffix && (
        <span className={cx("shrink-0 text-xs tabular-nums", line.failed ? "text-[var(--danger)]" : "text-ink-38")}>
          {line.suffix}
        </span>
      )}
      {pending && <Pulse className="shrink-0 text-ink-38" />}
      {body && <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="shrink-0 text-ink-38" />}
    </>
  );

  const link = target ? (
    <button
      type="button"
      onClick={() => openSession(target.id)}
      aria-label={`Open ${target.name}`}
      className="rise-1 grid size-6 shrink-0 place-items-center rounded-chip text-ink-38 hover:bg-raised hover:text-ink"
    >
      <Icon name="arrowUpRight" size={13} />
    </button>
  ) : null;

  if (!body) {
    return (
      <div className="flex max-w-full items-center gap-1.5">
        <div className="inline-flex h-7 min-w-0 items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1">{head}</div>
        {link}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex max-w-full items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rise-1 inline-flex h-7 min-w-0 items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1"
        >
          {head}
        </button>
        {link}
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-card bg-raised el-1">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="flex h-8 w-full items-center gap-2 border-b border-[var(--line-soft)] px-2.5 text-sm hover:bg-sunken"
      >
        {head}
      </button>
      <ToolBody block={block} />
    </div>
  );
});

function FoldChip({
  glyph,
  label,
  count,
  failed,
  live,
  open,
  onToggle,
}: {
  glyph: GlyphName;
  label: string;
  count?: number;
  failed?: boolean;
  live?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="rise-1 inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1"
    >
      <Icon name={glyph} size={13} className="shrink-0 text-ink-38" />
      <span className="min-w-0 truncate text-left text-ink-70">{label}</span>
      {count !== undefined && count > 1 && (
        <span className="shrink-0 rounded-full bg-sunken px-1.5 text-xs tabular-nums text-ink-52">{count}</span>
      )}
      {failed && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--danger)]">
          <Icon name="circleAlert" size={12} />
          failed
        </span>
      )}
      {live && <Pulse className="shrink-0 text-ink-38" />}
      <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="shrink-0 text-ink-38" />
    </button>
  );
}

function useResolveAgent(): (id: string) => string {
  const { sessionById } = useStore();
  return (id: string) => sessionById(id)?.name ?? id;
}

function PhaseGroup({
  phase,
  pinned,
  onPin,
  forceOpenId,
}: {
  phase: Phase;
  pinned: boolean;
  onPin: () => void;
  forceOpenId?: string;
}) {
  const resolve = useResolveAgent();
  const live = phaseOpen(phase);
  const needsAnswer = phase.blocks.some(isOpen);
  const failed = phaseFailed(phase);
  const bare = phase.blocks.length === 1 && !live;

  if (bare) return <BlockRow block={phase.blocks[0]!} />;

  const open = pinned || live || needsAnswer || phase.blocks.some((block) => block.id === forceOpenId);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <FoldChip
        glyph={crewPhaseGlyph(phase, resolve) ?? PHASE_GLYPH[phase.kind]}
        label={crewPhaseLabel(phase, resolve) ?? phaseLabel(phase)}
        count={phase.blocks.length}
        failed={failed}
        live={live}
        open={open}
        onToggle={onPin}
      />
      {open && (
        <div className="flex w-full flex-col items-start gap-1.5 pl-3">
          {phase.blocks.map((block) => (
            <BlockRow key={block.id} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockRow({ block }: { block: Block }) {
  if (block.role === "approval") return <ApprovalCard block={block} />;
  if (block.role === "question") return <QuestionCard block={block} />;
  return <ToolRow block={block} />;
}

function Reasoning({ block }: { block: Block }) {
  const [pinned, setPinned] = useState(false);
  const open = pinned || Boolean(block.streaming);
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => setPinned((held) => !held)}
        className="rise-1 inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-raised px-2 text-sm el-1"
      >
        <Icon name="brain" size={13} className="shrink-0 text-ink-38" />
        <span className="min-w-0 truncate text-left italic text-ink-52">
          {block.streaming ? "Thinking" : summarize(block.text, 72) || "Thought"}
        </span>
        {block.streaming && <Pulse className="shrink-0 text-ink-38" />}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="shrink-0 text-ink-38" />
      </button>
      {open && (
        <div className="w-full rounded-card bg-raised px-3.5 py-2.5 text-base italic text-ink-52 el-1">
          <p className="whitespace-pre-wrap">{block.text}</p>
        </div>
      )}
    </div>
  );
}

/**
 * One activity group. Three or more items fold behind a digest built from the
 * two biggest kinds — but never while something inside is still live or is
 * waiting on an answer.
 */
export const Activity = memo(function Activity({
  blocks,
  isLast,
  forceOpenId,
}: {
  blocks: Block[];
  isLast: boolean;
  /** A search hit inside a folded run must unfold whatever is holding it. */
  forceOpenId?: string;
}) {
  const items: ActivityItem[] = buildActivity(blocks);
  const [pins, setPins] = useState<string[]>([]);
  const [digestPinned, setDigestPinned] = useState(false);

  // Moving on to the next turn clears whatever the reader pinned open.
  useEffect(() => {
    if (!isLast) {
      setPins([]);
      setDigestPinned(false);
    }
  }, [isLast]);

  const resolve = useResolveAgent();
  const live = blocks.some((block) => block.tool?.status === "pending" || Boolean(block.streaming));
  const needsAnswer = blocks.some(isOpen);
  const failed = blocks.some((block) => block.tool?.status === "failed");
  const digest = activityDigest(items);
  const crewLabel = crewDigest(items, resolve);

  const body = (
    <div className="flex flex-col items-start gap-1.5">
      {items.map((item, index) => {
        if (item.kind === "reasoning") return <Reasoning key={item.block.id} block={item.block} />;
        if (item.kind === "question") return <QuestionCard key={item.block.id} block={item.block} />;
        const id = item.phase.id;
        return (
          <PhaseGroup
            key={`${id}-${index}`}
            phase={item.phase}
            pinned={pins.includes(id)}
            onPin={() => setPins((held) => (held.includes(id) ? held.filter((p) => p !== id) : [...held, id]))}
            {...(forceOpenId ? { forceOpenId } : {})}
          />
        );
      })}
    </div>
  );

  const revealed = forceOpenId !== undefined && blocks.some((block) => block.id === forceOpenId);
  if (items.length < FOLD_AT || live || needsAnswer) return body;

  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      <FoldChip
        glyph={crewLabel ? "users" : digest.kind === "thought" ? "brain" : PHASE_GLYPH[digest.kind]}
        label={crewLabel ?? digest.label}
        count={blocks.length}
        failed={failed}
        open={digestPinned || revealed}
        onToggle={() => setDigestPinned((held) => !held)}
      />
      {(digestPinned || revealed) && <div className="w-full pl-3">{body}</div>}
    </div>
  );
});

export function TurnFooter({ usage, at }: { usage: import("@crew/fixtures").TurnUsage; at?: number }) {
  const parts: string[] = [];
  if (usage.durationMs) parts.push(`Worked for ${formatDuration(usage.durationMs)}`);
  if (at) parts.push(clock(at));
  const detail = [
    usage.inputTokens !== undefined ? `${usage.inputTokens.toLocaleString()} in` : null,
    usage.outputTokens !== undefined ? `${usage.outputTokens.toLocaleString()} out` : null,
    usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const label = (
    <span className="select-none text-xs text-ink-38">{parts.join(" · ")}</span>
  );
  return detail ? <Tip content={detail} side="top">{label}</Tip> : label;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
