import { GitBranchIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { AgentAvatar } from "./AgentAvatar";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { useThread } from "../hooks/useThread";
import { modelLabel, providerOf } from "../lib/providers";
import { statusLabel } from "../lib/status";
import { elapsed } from "../lib/time";
import type { Session } from "../lib/types";

/** Where the card hangs: under the pill, its left edge on the pill's. */
export type PeekAnchor = { left: number; top: number };

/**
 * What a tab's session is up to, without switching to it: a hover card in the
 * manner of Linear's, with who it is, what state it is in and for how long,
 * where it runs, and the last thing it said.
 */
export function TabPeek({ session, branch, anchor }: { session: Session; branch: string | null; anchor: PeekAnchor }) {
  return createPortal(
    <div
      role="tooltip"
      style={{ left: anchor.left, top: anchor.top }}
      className="pointer-events-none fixed z-50 flex w-[300px] flex-col gap-2.5 rounded-float bg-surface p-3 text-text shadow-float"
    >
      <div className="flex items-center gap-2.5">
        {session.kind === "agent" ? (
          <AgentAvatar seed={session.id} bare className="size-8" />
        ) : (
          <span className="grid size-8 place-items-center rounded-lg bg-card">
            <ProviderIcon provider={session.provider} className="size-4.5" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{session.name}</span>
          <span className="flex items-center gap-1 truncate text-[12px] text-text-muted">
            <ProviderIcon provider={session.provider} className="size-3" />
            {providerOf(session.provider)?.label ?? session.provider} {modelLabel(session.provider, session.model)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="flex items-center gap-1.5 rounded-full bg-card px-2 py-0.5 ring-1 ring-hairline">
          {session.status === "idle" ? (
            <span className="size-2 rounded-full bg-border-strong" />
          ) : (
            <StatusDot status={session.status} className="size-3" />
          )}
          {statusLabel(session.status)}
          <span className="text-text-muted tabular-nums">· {elapsed(session.updatedAt)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-text-muted">
          <GitBranchIcon className="size-3 shrink-0 text-icon" />
          <span className="truncate">{branch ?? "main"}</span>
        </span>
      </div>

      {session.kind === "agent" && <LastWords sessionId={session.id} />}
    </div>,
    document.body,
  );
}

/** The newest line the agent wrote, or what it is doing if it is mid-turn. */
function LastWords({ sessionId }: { sessionId: string }) {
  const { blocks, ready } = useThread(sessionId);
  if (!ready) return null;
  const last = [...blocks].reverse().find((block) => (block.role === "assistant" || block.role === "user") && block.text.trim());
  const tool = blocks.at(-1)?.tool;
  const line = tool?.status === "pending" ? tool.title : last?.text.trim();
  if (!line) return null;
  return (
    <p className="line-clamp-3 border-t border-hairline pt-2.5 text-[12px] leading-[17px] text-text-muted">
      {tool?.status === "pending" ? <span className="crew-shimmer">{line}</span> : line}
    </p>
  );
}
