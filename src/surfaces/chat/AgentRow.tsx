// Orchestration: one agent's row in a card of the chat (a subagent, a started
// session), and the soft state chip every agent, run and command shares.
import { ChevronRightIcon, SquareTerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { BotAvatar } from "../../chrome/BotAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import type { PanelEntry, PanelState } from "../../lib/backgroundPanel";
import { modelLabel } from "../../lib/providers";
import type { Session, SessionStatus } from "../../lib/types";

export type Tone = "activity" | "background" | "warning" | "success" | "danger" | "info" | "quiet";

/** A state in its soft form: tinted ground, coloured ink, a glyph that says the same. */
export function StateChip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string | undefined }) {
  return (
    <span className="ds-chip" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** What a child says it is doing, in the chip's words. Its session wins over the work list, which only knows running or not. */
function agentState(
  state: PanelState,
  entry: PanelEntry | undefined,
  session: Pick<Session, "status"> | undefined,
): { tone: Tone; label: string } {
  if (entry?.attention === "question") return { tone: "warning", label: "Asks you" };
  if (entry?.attention === "approval") return { tone: "warning", label: "Approval" };
  const status: SessionStatus | undefined = session?.status;
  if (status === "needs-input") return { tone: "warning", label: "Asks you" };
  if (status === "error") return { tone: "danger", label: "Error" };
  if (status === "exited") return { tone: "quiet", label: "Exited" };
  if (status === "background") return { tone: "background", label: "In background" };
  if (status === "starting") return { tone: "activity", label: "Starting" };
  if (state === "running") return { tone: "activity", label: "Working" };
  if (state === "failed") return { tone: "danger", label: "Failed" };
  if (state === "stopped") return { tone: "quiet", label: "Stopped" };
  return { tone: "success", label: "Done" };
}

export type AgentRowPeer = { id?: string | undefined; name: string; provider?: string | undefined; bot?: boolean | undefined };

function Mark({ peer, provider }: { peer: AgentRowPeer | undefined; provider: string | undefined }) {
  if (peer?.bot && peer.id) return <BotAvatar seed={peer.id} bare className="size-4" />;
  if (provider) return <ProviderIcon provider={provider} className="size-4" />;
  return <SquareTerminalIcon aria-hidden className="size-4 text-icon" />;
}

/**
 * One agent: its CLI's mark on a tile, what it was asked, then who it is, the
 * model and how far it got; its state as a chip on the right and a chevron
 * when the row opens its thread. Hover fills, nothing moves.
 */
export function AgentRow({
  state,
  title,
  meta,
  peer,
  entry,
  session,
  fallback,
  onOpen,
}: {
  state: PanelState;
  title: string;
  meta: string;
  peer?: AgentRowPeer | undefined;
  entry?: PanelEntry | undefined;
  session?: Session | undefined;
  /** The mark to wear when nothing names its CLI: a native subagent's parent's. */
  fallback?: string | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const provider = entry?.provider ?? session?.provider ?? peer?.provider ?? fallback;
  const model = entry?.model ?? session?.model;
  const chip = agentState(state, entry, session);
  // The chip says the state; the meta keeps the tokens, the time and what it is on.
  const rest = meta.replace(/^running$/, "").replace(/(^| · )running$/, "");
  const who = peer && peer.name !== title ? peer.name : null;
  const sub = [who, model && provider ? modelLabel(provider, model) : model, rest].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="ds-agent-mark">
        <Mark peer={peer} provider={provider} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-[18px] text-text">{title}</span>
        {sub ? <span className="truncate text-[11.5px] leading-4 text-text-muted tabular-nums">{sub}</span> : null}
      </span>
      {/* Done is the quiet default: the row's own words say how it ended, a green badge would shout it. */}
      {chip.tone === "success" ? null : <StateChip tone={chip.tone}>{chip.label}</StateChip>}
      {onOpen ? <ChevronRightIcon aria-hidden className="ds-agent-go size-3.5" /> : <span className="w-3.5 shrink-0" />}
    </>
  );
  if (!onOpen)
    return (
      <div data-agent-card className="ds-agent" data-tone={chip.tone}>
        {body}
      </div>
    );
  return (
    <button type="button" data-agent-card onClick={onOpen} className="ds-agent" data-tone={chip.tone}>
      {body}
    </button>
  );
}
