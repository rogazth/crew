import type { ReactNode, RefObject } from "react";
import type { Answers, ApprovalDecision, AttachedFile, Block } from "../../lib/blocks";
import type { AgentChoice } from "../../lib/providers";
import type { Session } from "../../lib/types";
import type { PanelScope } from "./Panel";
import type { QueueScope } from "./Queue";

/** The contract the chat surface renders; TurnChat owns the state behind it. */
export type ChatSurfaceProps = {
  session: Session;
  blocks: Block[];
  working: boolean;
  ready: boolean;
  /** False while the tab sits behind another one. */
  active: boolean;
  /** The chat holds a window; older blocks are a click away. */
  more: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** The last block a search hit sent the reader to. */
  focusId: string | null;
  draft: string;
  files: AttachedFile[];
  over: boolean;
  field: RefObject<HTMLTextAreaElement | null>;
  onDraft: (draft: string) => void;
  /** `mode` is how a message written while a turn runs goes: absent when no turn runs. */
  onSend: (mode?: "steer" | "queue") => void;
  onStop: () => void;
  onAttach: () => void;
  onPasteFiles: (files: File[]) => void;
  onRemoveFile: (path: string) => void;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
  /** What Enter does with a message while a turn runs; absent, it waits for the turn to end. */
  whileWorking?: "steer" | "queue";
  /** The user's messages still in the box, above the composer. */
  queue?: QueueScope;
  /** The session's background work, in the composer's status line. */
  work?: PanelScope;
  /** Nothing to show yet, and no intro either: the conversation is still being read. */
  loading?: boolean;
  /** The composer's model, effort and access chips changed. Absent: no chips. */
  onOptions?: (next: AgentChoice) => void;
  /** The model chip offers other providers: a session nobody has talked to yet. */
  switchProvider?: boolean;
  /** A chip changed that only a relaunch reaches; the next message does it. */
  optionsPending?: boolean;
  /** In a thread, the chat of an agent the user may write to: Esc goes back instead of stopping its turn. */
  inThread?: boolean;
  /** No composer: the thread says why in its own footer. */
  readOnly?: boolean;
  /** Over the chat: its sessions, whose it is, its conversations. */
  bar?: ReactNode;
  /** Drawn over the transcript and the composer: a pair's thread, a background entry. */
  overlay?: ReactNode;
};
