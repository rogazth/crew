/** Transcript rows Crew paints. The vendor session is not this list. */
export type BlockRole = "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "system";

/** `interrupted` is a pending row whose process is gone: no spinner, no verdict. */
export type ToolStatus = "pending" | "completed" | "failed" | "interrupted";

/** `always` allows and asks the provider to stop prompting for the same kind of call this session. */
export type ApprovalDecision = "allow" | "always" | "deny";

export type AttachedFile = {
  name: string;
  path: string;
  kind?: "image" | "file";
  size?: number;
};

export type QuestionOption = { label: string; description?: string };

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

/** Keyed by question text; a multi-select joins labels with ", " (what Claude Code accepts). */
export type Answers = Record<string, string>;

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
  /** Wall clock, ms. Set on what the user sent and on the reply that closed a turn. */
  at?: number;
  /** Sent on the user's behalf (a routine waking the agent); the transcript does not paint it. */
  hidden?: boolean;
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
    /** The call as the provider will run it; a card shows the command or the diff. */
    input?: Record<string, unknown>;
    decided?: ApprovalDecision;
  };
  question?: {
    requestId: number;
    questions: Question[];
    answers?: Answers;
    dismissed?: boolean;
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
  | { type: "reasoning.delta"; text: string }
  | { type: "turn.completed"; usage?: TurnUsage }
  | { type: "tool.started"; callId: string; name: string; title: string }
  | { type: "tool.updated"; callId: string; title?: string; status?: ToolStatus }
  | {
      type: "approval.requested";
      requestId: number;
      name: string;
      title: string;
      input?: Record<string, unknown>;
    }
  | { type: "approval.resolved"; requestId: number; decision: ApprovalDecision | "cancelled" }
  | { type: "question.requested"; requestId: number; questions: Question[] }
  | { type: "question.resolved"; requestId: number; answers: Answers | null };

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

/** Anything still waiting on the provider or the user. */
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

/** Fold a live harness event into the transcript. Pure so the turn engine stays dumb. */
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
      // The approval row was this same call asking first; one line, not two.
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
      // The provider announced the ask as a tool call first; the card is that call.
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
