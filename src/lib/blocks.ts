/** Transcript rows Crew paints. The vendor session is not this list. */
export type BlockRole = "user" | "assistant" | "tool" | "approval" | "system";

export type ToolStatus = "pending" | "completed" | "failed";

export type ApprovalDecision = "allow" | "deny";

export type AttachedFile = {
  name: string;
  path: string;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  streaming?: boolean;
  files?: AttachedFile[];
  tool?: {
    callId: string;
    title: string;
    status: ToolStatus;
  };
  approval?: {
    requestId: number;
    decided?: ApprovalDecision;
  };
};

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.providerBound"; providerSessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | { type: "tool.started"; callId: string; title: string }
  | { type: "tool.updated"; callId: string; title?: string; status?: ToolStatus }
  | { type: "approval.requested"; requestId: number; title: string }
  | { type: "approval.resolved"; requestId: number; decision: ApprovalDecision | "cancelled" };

export function newBlock(role: BlockRole, text = ""): Block {
  return { id: crypto.randomUUID(), role, text };
}

export function parseBlocks(raw: string | null | undefined): Block[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBlock);
  } catch {
    return [];
  }
}

function isBlock(value: unknown): value is Block {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<Block>;
  return typeof row.id === "string" && typeof row.role === "string" && typeof row.text === "string";
}

export function settleStreaming(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.streaming ? { ...block, streaming: false } : block));
}

/** Fold a live harness event into the transcript. Pure so the turn engine stays dumb. */
export function applyEvent(blocks: Block[], event: HarnessEvent): Block[] {
  switch (event.type) {
    case "message.delta":
      return appendAssistant(blocks, event.text);
    case "message.completed":
      return settleStreaming(blocks);
    case "tool.started": {
      const settled = settleStreaming(blocks);
      return [
        ...settled,
        {
          ...newBlock("tool", event.title),
          tool: { callId: event.callId, title: event.title, status: "pending" },
        },
      ];
    }
    case "tool.updated":
      return blocks.map((block) => {
        if (block.tool?.callId !== event.callId) return block;
        const title = event.title ?? block.tool.title;
        return {
          ...block,
          text: title,
          tool: {
            ...block.tool,
            title,
            status: event.status ?? block.tool.status,
          },
        };
      });
    case "approval.requested":
      return [
        ...settleStreaming(blocks),
        {
          ...newBlock("approval", event.title),
          approval: { requestId: event.requestId },
        },
      ];
    case "approval.resolved":
      return blocks.map((block) =>
        block.approval?.requestId === event.requestId
          ? {
              ...block,
              approval: {
                requestId: event.requestId,
                ...(event.decision === "cancelled" ? {} : { decided: event.decision }),
              },
            }
          : block,
      );
    case "session.error":
      return [...settleStreaming(blocks), newBlock("system", event.message)];
    default:
      return blocks;
  }
}

function appendAssistant(blocks: Block[], text: string): Block[] {
  const last = blocks.at(-1);
  if (last?.role === "assistant" && last.streaming) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...settleStreaming(blocks), { ...newBlock("assistant", text), streaming: true }];
}
