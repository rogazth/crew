/** Transcript rows Crew paints. The vendor session is not this list. */
export type BlockRole = "user" | "assistant" | "tool" | "approval" | "system";

/** `interrupted` is a pending row whose process is gone: no spinner, no verdict. */
export type ToolStatus = "pending" | "completed" | "failed" | "interrupted";

export type ApprovalDecision = "allow" | "deny";

export type AttachedFile = {
  name: string;
  path: string;
};

export type TurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  streaming?: boolean;
  files?: AttachedFile[];
  tool?: {
    callId: string;
    /** Provider tool name; picks the glyph. */
    name: string;
    title: string;
    status: ToolStatus;
  };
  approval?: {
    requestId: number;
    name: string;
    decided?: ApprovalDecision;
  };
  /** Set on the assistant block that closed a turn. */
  usage?: TurnUsage;
};

export type HarnessEvent =
  | { type: "session.started" }
  | { type: "session.ended"; code?: number | null }
  | { type: "session.error"; message: string }
  | { type: "session.note"; message: string }
  | { type: "session.providerBound"; providerSessionId: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed" }
  | { type: "turn.completed"; usage?: TurnUsage }
  | { type: "tool.started"; callId: string; name: string; title: string }
  | { type: "tool.updated"; callId: string; title?: string; status?: ToolStatus }
  | { type: "approval.requested"; requestId: number; name: string; title: string }
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

/**
 * Nothing may stay open once the turn is over: a pending tool has either run
 * (`completed`) or its process died (`interrupted`); an unanswered approval
 * was never granted.
 */
export function settleTurn(blocks: Block[], tools: "completed" | "interrupted"): Block[] {
  return settleStreaming(blocks).map((block) => {
    if (block.tool?.status === "pending") return { ...block, tool: { ...block.tool, status: tools } };
    if (block.approval && !block.approval.decided) {
      return { ...block, approval: { ...block.approval, decided: "deny" } };
    }
    return block;
  });
}

/** Fold a live harness event into the transcript. Pure so the turn engine stays dumb. */
export function applyEvent(blocks: Block[], event: HarnessEvent): Block[] {
  switch (event.type) {
    case "message.delta":
      return appendAssistant(blocks, event.text);
    case "message.completed":
      return settleStreaming(blocks);
    case "turn.completed": {
      const settled = settleTurn(blocks, "completed");
      const usage = event.usage;
      if (!usage) return settled;
      let index = settled.length - 1;
      while (index >= 0 && settled[index]?.role !== "assistant") index -= 1;
      if (index < 0) return settled;
      return settled.map((block, i) => (i === index ? { ...block, usage } : block));
    }
    case "tool.started": {
      const settled = settleStreaming(blocks);
      return [
        ...settled,
        {
          ...newBlock("tool", event.title),
          tool: { callId: event.callId, name: event.name, title: event.title, status: "pending" },
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
          approval: { requestId: event.requestId, name: event.name },
        },
      ];
    case "approval.resolved":
      return blocks.map((block) =>
        block.approval?.requestId === event.requestId
          ? {
              ...block,
              approval: {
                requestId: event.requestId,
                name: block.approval.name,
                decided: event.decision === "cancelled" ? "deny" : event.decision,
              },
            }
          : block,
      );
    case "session.error":
      return [...settleTurn(blocks, "interrupted"), newBlock("system", event.message)];
    case "session.ended":
      return settleTurn(blocks, "interrupted");
    case "session.note":
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
