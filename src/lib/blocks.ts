import type {
  ApprovalDecision,
  AttachedFile,
  Block,
  BlockRole,
  HarnessEvent,
  Question,
  ToolStatus,
  TurnUsage,
} from "./protocol";

export type {
  ApprovalDecision,
  AttachedFile,
  Block,
  BlockRole,
  HarnessEvent,
  Question,
  ToolStatus,
  TurnUsage,
};

export type Answers = { [key in string]: string };

export function newBlock(role: BlockRole, text = ""): Block {
  return { id: crypto.randomUUID(), role, text, at: Date.now() };
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

export function isOpen(block: Block): boolean {
  if (block.role === "tool") return block.tool?.status === "pending";
  if (block.role === "approval") return block.approval != null && !block.approval.decided;
  if (block.role === "question") {
    return block.question != null && !block.question.answers && !block.question.dismissed;
  }
  return false;
}

export function settleStreaming(blocks: Block[]): Block[] {
  return blocks.map((block) => (block.streaming ? { ...block, streaming: false } : block));
}

/**
 * Nothing may stay open once the turn is over: a pending tool has either run
 * (`completed`) or its process died (`interrupted`); an unanswered approval
 * was never granted; an unanswered question was dismissed.
 */
export function settleTurn(blocks: Block[], tools: "completed" | "interrupted"): Block[] {
  return settleStreaming(blocks).map((block) => {
    if (block.tool?.status === "pending") return { ...block, tool: { ...block.tool, status: tools } };
    if (block.approval && !block.approval.decided) {
      return { ...block, approval: { ...block.approval, decided: "deny" } };
    }
    if (block.question && !block.question.answers && !block.question.dismissed) {
      return { ...block, question: { ...block.question, dismissed: true } };
    }
    return block;
  });
}

export function applyEvent(blocks: Block[], event: HarnessEvent): Block[] {
  switch (event.type) {
    case "message.delta":
      return appendStreaming(blocks, "assistant", event.text);
    case "reasoning.delta":
      return appendStreaming(blocks, "reasoning", event.text);
    case "message.completed":
      return settleStreaming(blocks);
    case "turn.completed": {
      const settled = settleTurn(blocks, "completed");
      const usage = event.usage;
      if (!usage) return settled;
      let index = settled.length - 1;
      while (index >= 0 && settled[index]?.role !== "assistant") index -= 1;
      if (index < 0) return settled;
      return settled.map((block, i) => (i === index ? { ...block, usage, at: Date.now() } : block));
    }
    case "tool.started": {
      const settled = settleStreaming(blocks);
      const tool: Block = {
        ...newBlock("tool", event.title),
        tool: { callId: event.callId, name: event.name, title: event.title, status: "pending" },
      };
      const last = settled.at(-1);
      if (last?.approval && last.approval.decided !== "deny" && last.text === event.title) {
        return [...settled.slice(0, -1), { ...tool, id: last.id }];
      }
      return [...settled, tool];
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
          approval: {
            requestId: event.requestId,
            name: event.name,
            ...(event.input ? { input: event.input } : {}),
          },
        },
      ];
    case "approval.resolved":
      return blocks.map((block) =>
        block.approval?.requestId === event.requestId
          ? {
              ...block,
              approval: {
                ...block.approval,
                decided: event.decision === "cancelled" ? "deny" : event.decision,
              },
            }
          : block,
      );
    case "question.requested": {
      const settled = settleStreaming(blocks);
      const first = event.questions[0];
      const card: Block = {
        ...newBlock("question", first?.header || first?.question || "Question"),
        question: { requestId: event.requestId, questions: event.questions },
      };
      const last = settled.at(-1);
      if (last?.tool?.status === "pending" && isQuestionTool(last.tool.name)) {
        return [...settled.slice(0, -1), { ...card, id: last.id }];
      }
      return [...settled, card];
    }
    case "question.resolved":
      return blocks.map((block) =>
        block.question?.requestId === event.requestId
          ? {
              ...block,
              question: {
                ...block.question,
                ...(event.answers ? { answers: event.answers } : { dismissed: true }),
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

export function isQuestionTool(name: string): boolean {
  return /^askuserquestion$/i.test(name);
}

function appendStreaming(blocks: Block[], role: "assistant" | "reasoning", text: string): Block[] {
  const last = blocks.at(-1);
  if (last?.role === role && last.streaming) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...settleStreaming(blocks), { ...newBlock(role, text), streaming: true }];
}
