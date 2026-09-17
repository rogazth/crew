import type {
  AgentRef,
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
  AgentRef,
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

function lastIndex(blocks: Block[], match: (block: Block) => boolean): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (match(blocks[index]!)) return index;
  }
  return -1;
}

function replaceAt(blocks: Block[], at: number, block: Block): Block[] {
  const next = blocks.slice();
  next[at] = block;
  return next;
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
      // The last block of the turn, the same one the daemon writes it to. It
      // is also the one place the reader is certainly looking: a window holds
      // the newest blocks, and a reply from before the window is not in it.
      const index = settled.length - 1;
      if (index < 0) return settled;
      return settled.map((block, i) => (i === index ? { ...block, usage, at: Date.now() } : block));
    }
    case "tool.started": {
      const settled = settleStreaming(blocks);
      const tool: Block = {
        ...newBlock("tool", event.title),
        tool: {
          callId: event.callId,
          name: event.name,
          title: event.title,
          status: "pending",
          ...(event.detail ? { detail: event.detail } : {}),
        },
      };
      const last = settled.at(-1);
      if (last?.approval && last.approval.decided !== "deny" && last.text === event.title) {
        return [...settled.slice(0, -1), { ...tool, id: last.id, approval: last.approval }];
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
            // An update with no detail is a status change, not an erasure: the
            // command a row already showed stays on it.
            ...(event.detail ? { detail: event.detail } : {}),
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
    case "approval.resolved": {
      // Request ids restart with every turn, so the id alone names an approval
      // in every turn that ever ran. Only the newest one still waiting can be
      // the one being answered.
      const at = lastIndex(
        blocks,
        (block) => block.approval?.requestId === event.requestId && block.approval.decided === undefined,
      );
      if (at < 0) return blocks;
      const block = blocks[at]!;
      const decided = event.decision === "cancelled" ? "deny" : event.decision;
      return replaceAt(blocks, at, {
        ...block,
        approval: { ...block.approval!, decided },
      });
    }
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
    case "question.resolved": {
      const at = lastIndex(
        blocks,
        (block) =>
          block.question?.requestId === event.requestId &&
          block.question.answers === undefined &&
          block.question.dismissed !== true,
      );
      if (at < 0) return blocks;
      const block = blocks[at]!;
      return replaceAt(blocks, at, {
        ...block,
        question: {
          ...block.question!,
          ...(event.answers ? { answers: event.answers } : { dismissed: true }),
        },
      });
    }
    case "session.error":
      return [...settleTurn(blocks, "interrupted"), newBlock("system", event.message)];
    case "session.ended":
      return settleTurn(blocks, "interrupted");
    case "session.note":
      return [...settleStreaming(blocks), newBlock("system", event.message)];
    case "user.message": {
      const block: Block = {
        ...newBlock("user", event.text),
        ...(event.hidden ? { hidden: true } : {}),
        ...(event.files && event.files.length > 0 ? { files: event.files } : {}),
        ...(event.fromAgent ? { fromAgent: event.fromAgent } : {}),
      };
      return [...blocks, block];
    }
    case "system.message":
      return [...blocks, newBlock("system", event.text)];
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
