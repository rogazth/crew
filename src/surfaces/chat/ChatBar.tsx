import { Menu } from "@base-ui/react/menu";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  ShieldQuestionIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { PANEL, ROW } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { childState, pairThread, partyOf, sessionParty, type ChildState, type Party, type ThreadRef } from "../../lib/letters";
import type { ThreadPair } from "../../lib/protocol";
import { summarize } from "../../lib/activity";
import { clock } from "../../lib/time";
import type { Session } from "../../lib/types";
import { Face } from "./Letters";

const STATE: Record<ChildState, { label: string; glyph: ReactNode }> = {
  working: { label: "Working", glyph: <LoaderCircleIcon className="size-3 animate-spin text-warning" /> },
  starting: { label: "Starting", glyph: <LoaderCircleIcon className="size-3 animate-spin text-icon" /> },
  reported: { label: "Reported", glyph: <CheckIcon className="size-3 text-success" /> },
  question: { label: "Question", glyph: <MessageCircleQuestionIcon className="size-3 text-warning" /> },
  approval: { label: "Waiting for approval", glyph: <ShieldQuestionIcon className="size-3 text-warning" /> },
  failed: { label: "Failed", glyph: <XIcon className="size-3 text-danger" /> },
  stopped: { label: "Stopped", glyph: <SquareIcon className="size-2.5 text-icon" /> },
  exited: { label: "Exited", glyph: <CircleSlashIcon className="size-3 text-icon" /> },
};

/** How many reported children it takes before they fold into one chip. */
const FOLD_DONE_AT = 3;

/** One child: the tab pill's shape, the CLI's mark, its name and where it stands. */
function ChildChip({ child, onOpen }: { child: Session; onOpen: (id: string) => void }) {
  const state = STATE[childState(child)];
  return (
    <button
      type="button"
      onClick={() => onOpen(child.id)}
      title={`${child.name}: ${state.label.toLowerCase()}. Open its chat.`}
      className="flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded-chrome bg-card px-2 text-[12.5px] transition-colors hover:bg-hover"
    >
      <ProviderIcon provider={child.provider} className="size-3.5" />
      <span className="min-w-0 truncate">{child.name}</span>
      <span className="flex shrink-0 items-center gap-1 pl-0.5 text-[11px] text-text-muted">
        {state.glyph}
        {state.label}
      </span>
    </button>
  );
}

/**
 * A session's children, where they live: inside its chat, not in the sidebar.
 * Reported ones fold into "N done" once there are a few; a click unfolds them.
 */
export function SessionsStrip({ kids, onOpen, label = true }: { kids: Session[]; onOpen: (id: string) => void; label?: boolean }) {
  const [unfolded, setUnfolded] = useState(false);
  const reported = kids.filter((child) => childState(child) === "reported");
  const folds = reported.length >= FOLD_DONE_AT && !unfolded;
  const shown = folds ? kids.filter((child) => childState(child) !== "reported") : kids;
  return (
    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {label && <span className="mr-1.5 shrink-0 text-[12px] text-text-muted">Sessions</span>}
      {shown.map((child) => (
        <ChildChip key={child.id} child={child} onOpen={onOpen} />
      ))}
      {reported.length >= FOLD_DONE_AT && (
        <button
          type="button"
          onClick={() => setUnfolded(!unfolded)}
          aria-expanded={!folds}
          className="flex h-7 shrink-0 items-center gap-1 rounded-chrome px-2 text-[12px] text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <CheckIcon className="size-3 text-success" />
          {folds ? `${reported.length} done` : "Fold done"}
          <ChevronDownIcon className={`size-3 transition-transform duration-150 ${folds ? "" : "rotate-180"}`} />
        </button>
      )}
    </div>
  );
}

/** A child's chat says whose it is; a handoff says it is yours now. */
function Owner({ session, sessions }: { session: Session; sessions: readonly Session[] }) {
  const id = session.handedOffBy ?? session.parentId ?? "";
  const name = (session.handedOffBy ? session.handedOffByName : session.parentName) ?? "a session";
  const parent = sessions.find((row) => row.id === id);
  const party: Party = parent ? sessionParty(parent) : { id, name };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-text-muted">
      <Face party={party} sessions={sessions} className="size-4" />
      {session.handedOffBy ? (
        <span className="truncate">
          Handed off by <span className="text-text">{name}</span> · yours
        </span>
      ) : (
        <span className="truncate">
          Started by <span className="text-text">{name}</span> · reports to it when a turn ends
        </span>
      )}
      {session.worktree && (
        <span title={session.worktree} className="flex min-w-0 shrink items-center gap-1 rounded-md bg-card px-1.5 py-0.5 font-mono text-[11px]">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{session.worktree.split("/").pop()}</span>
        </span>
      )}
    </div>
  );
}

const BAR_BUTTON =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-chrome px-2 text-[12.5px] text-icon transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text";

/** The way into this chat's threads: straight in when there is one, a menu of pairs when there are more. */
function Conversations({
  pairs,
  owner,
  sessions,
  onOpen,
}: {
  pairs: ThreadPair[];
  owner: Party;
  sessions: readonly Session[];
  onOpen: (thread: ThreadRef) => void;
}) {
  if (pairs.length === 0) return null;
  const label = (
    <>
      <MessagesSquareIcon className="size-3.5" />
      Conversations
      <span className="text-text-muted tabular-nums">{pairs.length}</span>
    </>
  );
  if (pairs.length === 1) {
    const { a, b } = pairThread(pairs[0]!, owner);
    return (
      <button type="button" onClick={() => onOpen({ a, b })} className={BAR_BUTTON}>
        {label}
      </button>
    );
  }
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className={BAR_BUTTON}>
        {label}
        <ChevronDownIcon className="size-3 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={`${PANEL} w-80`}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Conversations</div>
            {pairs.map((pair) => {
              const thread = pairThread(pair, owner);
              const from = partyOf(pair.last.from);
              const first = summarize(pair.last.text);
              return (
                <Menu.Item key={`${pair.peer.id}:${pair.with?.id ?? ""}`} onClick={() => onOpen({ a: thread.a, b: thread.b })} className={`${ROW} h-11`}>
                  <Face party={thread.peer} sessions={sessions} className="size-5" />
                  <span className="flex min-w-0 flex-1 flex-col leading-4">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{thread.label}</span>
                      <span className="shrink-0 text-[11px] text-placeholder tabular-nums">{clock(pair.last.at)}</span>
                    </span>
                    <span className="truncate text-[11.5px] text-text-muted">
                      {from.name}: {first}
                    </span>
                  </span>
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type Props = {
  session: Session;
  sessions: readonly Session[];
  /** Its children, oldest first. */
  kids: Session[];
  pairs: ThreadPair[];
  onOpenSession: (id: string) => void;
  onOpenThread: (thread: ThreadRef) => void;
  /** Kept at the bar's end, there or not: the terminal's own button. */
  trailing?: ReactNode;
};

/**
 * The bar over a chat: its sessions, or whose it is, on the left; its
 * conversations on the right. Nothing to say, no bar, unless something
 * trails it.
 */
export function ChatBar({ session, sessions, kids, pairs, onOpenSession, onOpenThread, trailing }: Props) {
  const owned = Boolean(session.parentId || session.handedOffBy);
  if (kids.length === 0 && !owned && pairs.length === 0) {
    return trailing ? <div className="flex h-10 shrink-0 items-center justify-end px-3">{trailing}</div> : null;
  }
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline pr-2 pl-4">
      {kids.length > 0 ? (
        <SessionsStrip kids={kids} onOpen={onOpenSession} />
      ) : owned ? (
        <Owner session={session} sessions={sessions} />
      ) : (
        <span className="flex-1" />
      )}
      <Conversations pairs={pairs} owner={sessionParty(session)} sessions={sessions} onOpen={onOpenThread} />
      {trailing}
    </div>
  );
}
