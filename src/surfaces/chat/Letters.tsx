import { ArrowRightIcon, BotIcon, MessageSquareIcon, UserIcon, XIcon } from "lucide-react";
import { memo } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { botLabel } from "../../lib/botNames";
import type { Block } from "../../lib/blocks";
import { checkpointOf, refusalOf, resolveParty, USER, type Party } from "../../lib/letters";
import { clock } from "../../lib/time";
import type { Session } from "../../lib/types";
import { AttachmentStrip } from "./Attachments";
import { useLetterScope } from "./context";
import { Note, UserMessage } from "./Message";

/** A bot is its face; a session is its CLI's mark; the user is the person glyph. */
export function Face({ party, sessions, className = "size-4" }: { party: Party; sessions: readonly Session[]; className?: string }) {
  if (party.kind === "user" || party.id === USER) {
    return <UserIcon aria-hidden className={`${className} shrink-0 rounded-full bg-card p-[2px] text-icon`} />;
  }
  const session = party.id ? sessions.find((row) => row.id === party.id) : undefined;
  if (session?.kind === "bot" || (!session && party.id && party.kind === undefined)) {
    return <BotAvatar seed={party.id} bare className={`${className} shrink-0`} />;
  }
  if (session) return <ProviderIcon provider={session.provider} className={`${className} shrink-0`} />;
  return <BotIcon aria-hidden className={`${className} shrink-0 text-icon`} />;
}

/**
 * Who wrote to whom, at the point it happened, and nothing else: the words
 * live in that pair's thread, one click away. A note whose words do not say
 * who is drawn as the note it is.
 */
export const CheckpointRow = memo(function CheckpointRow({ block }: { block: Block }) {
  const { owner, sessions, openThread } = useLetterScope();
  const mark = owner ? checkpointOf(block, owner, botLabel) : null;
  if (!owner || !mark) return block.role === "user" ? <UserMessage block={block} /> : <Note block={block} />;
  const from = resolveParty(mark.from, sessions, owner.id);
  const to = resolveParty(mark.to, sessions, owner.id);
  return (
    <button
      type="button"
      data-letter={mark.letterId}
      onClick={() => openThread({ a: from, b: to, focus: mark.letterId })}
      title={`Open the conversation between ${from.name} and ${to.name}`}
      className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]"
    >
      <span className="crew-node">
        <MessageSquareIcon className="size-3.5" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-text-muted transition-colors group-hover:text-text">
        <Face party={from} sessions={sessions} className="size-3.5" />
        <span className="truncate">{from.name}</span>
        <ArrowRightIcon aria-label="to" className="size-3 shrink-0 text-placeholder" />
        <Face party={to} sessions={sessions} className="size-3.5" />
        <span className="truncate">{to.name}</span>
      </span>
      <span className="h-px min-w-4 flex-1 bg-hairline" />
      {mark.at !== undefined && <span className="shrink-0 text-[11px] text-placeholder tabular-nums">{clock(mark.at)}</span>}
    </button>
  );
});

/** A send Crew refused: the call failed, nothing was delivered, and the row says why. */
export const RefusedRow = memo(function RefusedRow({ block }: { block: Block }) {
  const refused = refusalOf(block, botLabel);
  if (!refused) return null;
  const first = refused.text.split("\n").find((line) => line.trim() !== "") ?? "";
  return (
    <div className="flex min-h-[26px] items-start gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="crew-node mt-0.5">
        <XIcon className="size-3 text-danger" />
      </span>
      <span className="min-w-0">
        <span className="text-danger">Not sent to {refused.to}</span>
        {first && <span className="text-placeholder"> · “{first}”</span>}
        {refused.reason && <span className="block text-[12px] text-text-muted">{refused.reason}</span>}
      </span>
    </div>
  );
});

/**
 * What waits for the next turn: the user's own messages as their bubbles,
 * dimmed, and letters from others as one line each, under one label for all.
 */
export const QueuedGroup = memo(function QueuedGroup({ blocks }: { blocks: Block[] }) {
  const { sessions } = useLetterScope();
  return (
    <div className="flex flex-col items-end gap-1.5 opacity-60">
      {blocks.map((block) =>
        block.fromBot ? (
          <div key={block.id} className="flex max-w-[78%] items-center gap-1.5 text-[13px] leading-[18px]">
            <Face party={{ id: block.fromBot.id, name: block.fromBot.name, ...(block.fromBot.kind ? { kind: block.fromBot.kind } : {}) }} sessions={sessions} className="size-4" />
            <span className="shrink-0 font-medium">{block.fromBot.name}</span>
            <span className="min-w-0 truncate text-text-muted">{block.text.split("\n").find((line) => line.trim() !== "") ?? ""}</span>
          </div>
        ) : (
          // Stretched to the row, as a sent bubble's is: shrunk to its content,
          // the bubble's 78% would be of its own width and wrap short.
          <div key={block.id} className="flex flex-col items-end gap-1.5 self-stretch">
            {block.text ? (
              <div className="crew-md-row is-user">
                <div className="crew-bubble">
                  <p className="whitespace-pre-wrap">{block.text}</p>
                </div>
              </div>
            ) : null}
            {block.files && block.files.length > 0 ? <AttachmentStrip files={block.files} /> : null}
          </div>
        ),
      )}
      <span className="text-[11px] text-text-muted">{blocks.length > 1 ? `${blocks.length} queued` : "Queued"}</span>
    </div>
  );
});
