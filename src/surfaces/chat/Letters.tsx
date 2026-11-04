import { BotIcon, UserIcon, XIcon } from "lucide-react";
import { memo } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { botLabel } from "../../lib/botNames";
import type { Block } from "../../lib/blocks";
import { refusalOf, USER, type Party } from "../../lib/letters";
import type { Session } from "../../lib/types";
import { useLetterScope } from "./context";
import { QueuedBubble } from "./Queue";

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
  return <BotIcon aria-hidden data-face="unknown" className={`${className} shrink-0 text-icon`} />;
}

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
    <div className="flex flex-col items-end gap-1.5">
      {blocks.map((block) =>
        block.fromBot ? (
          <div key={block.id} className="flex max-w-[78%] items-center gap-1.5 text-[13px] leading-[18px] opacity-60">
            <Face party={{ id: block.fromBot.id, name: block.fromBot.name, ...(block.fromBot.kind ? { kind: block.fromBot.kind } : {}) }} sessions={sessions} className="size-4" />
            <span className="min-w-0 truncate font-medium">{block.fromBot.name}</span>
            <span className="shrink-0 text-text-muted">wrote</span>
          </div>
        ) : (
          <QueuedBubble key={block.id} block={block} />
        ),
      )}
      <span className="text-[11px] text-text-muted opacity-60">Queued</span>
    </div>
  );
});
