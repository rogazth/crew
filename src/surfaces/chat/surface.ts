import type { RefObject } from "react";
import type { Answers, ApprovalDecision, AttachedFile, Block } from "../../lib/blocks";
import type { Session } from "../../lib/types";

/** The contract every agent theme renders; AgentChat owns the state behind it. */
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
  onSend: () => void;
  onStop: () => void;
  onAttach: () => void;
  onPasteFiles: (files: File[]) => void;
  onRemoveFile: (path: string) => void;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};
