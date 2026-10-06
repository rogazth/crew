import type {
  BotRef,
  ApprovalDecision,
  AttachedFile,
  Block,
  BlockRole,
  HarnessEvent,
  Question,
  SubagentState,
  ToolDetail,
  ToolStatus,
  TurnUsage,
} from "./protocol";

export type {
  BotRef,
  ApprovalDecision,
  AttachedFile,
  Block,
  BlockRole,
  HarnessEvent,
  Question,
  SubagentState,
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

/**
 * A card the user has to answer. A running tool is open too, but it waits on
 * the agent, not on them.
 */
export function awaitsUser(block: Block): boolean {
  return (block.role === "approval" || block.role === "question") && isOpen(block);
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
    // A turn that ends leaves a background subagent running; a process that
    // dies takes it along.
    if (tools === "interrupted" && block.tool) {
      const detail = block.tool.detail;
      if (detail?.kind === "agent" && (detail.state === undefined || detail.state === "running")) {
        const stopped: ToolDetail = {
          ...detail,
          ...(detail.state ? { state: "stopped" as const } : {}),
          ...(detail.steps ? { steps: settleTurn(detail.steps, "interrupted") } : {}),
        };
        const status = block.tool.status === "pending" ? tools : block.tool.status;
        block = { ...block, tool: { ...block.tool, status, detail: stopped } };
      }
    }
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
            ...(event.detail ? { detail: merged(block.tool.detail, event.detail) } : {}),
          },
        };
      });
    case "subagent.event": {
      const step = stepEvent(event.event);
      if (!step) return blocks;
      return withSubagent(blocks, event.callId, (detail) => ({
        ...detail,
        state: detail.state ?? "running",
        steps: applyEvent(detail.steps ?? [], step),
      }));
    }
    case "subagent.updated":
      return withSubagent(blocks, event.callId, (detail) => {
        const next: AgentDetail = { ...detail };
        if (event.background !== undefined) next.background = event.background;
        if (event.output?.trim()) next.output = event.output;
        if (event.activity !== undefined) next.activity = event.activity;
        if (event.state) {
          next.state = event.state;
          if (event.state !== "running") {
            delete next.activity;
            if (next.steps) next.steps = settleTurn(next.steps, event.state === "done" ? "completed" : "interrupted");
          }
        }
        return next;
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
        ...(event.fromBot ? { fromBot: event.fromBot } : {}),
        ...(event.letterId ? { letterId: event.letterId } : {}),
      };
      return [...blocks, block];
    }
    case "system.message":
      return [...blocks, { ...newBlock("system", event.text), ...(event.letterId ? { letterId: event.letterId } : {}) }];
    default:
      return blocks;
  }
}

type AgentDetail = Extract<ToolDetail, { kind: "agent" }>;

/**
 * A call's new detail, keeping what only its subagent's own events fill in:
 * the call's updates know its input and its result, not its steps.
 */
function merged(old: ToolDetail | undefined, next: ToolDetail): ToolDetail {
  if (old?.kind !== "agent" || next.kind !== "agent") return next;
  const kept: Partial<AgentDetail> = {};
  if (next.output === undefined && old.output !== undefined) kept.output = old.output;
  if (next.background === undefined && old.background !== undefined) kept.background = old.background;
  if (next.state === undefined && old.state !== undefined) kept.state = old.state;
  if (next.activity === undefined && old.activity !== undefined) kept.activity = old.activity;
  if (next.steps === undefined && old.steps !== undefined) kept.steps = old.steps;
  return { ...next, ...kept };
}

/** The newest subagent call `callId`, changed by `change`; the rest as they were. */
function withSubagent(blocks: Block[], callId: string, change: (detail: AgentDetail) => AgentDetail): Block[] {
  const at = lastIndex(blocks, (block) => block.tool?.callId === callId && block.tool.detail?.kind === "agent");
  if (at < 0) return blocks;
  const block = blocks[at]!;
  const tool = block.tool!;
  return replaceAt(blocks, at, { ...block, tool: { ...tool, detail: change(tool.detail as AgentDetail) } });
}

/** What of a subagent's own events is a step: its words and its calls. */
function stepEvent(event: HarnessEvent): HarnessEvent | null {
  switch (event.type) {
    case "message.delta":
    case "message.completed":
    case "reasoning.delta":
    case "tool.started":
    case "tool.updated":
      return event;
    default:
      return null;
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

/** What was chosen, once the card has done its job. */
export function answerSummary(block: Block): string {
  const ask = block.question;
  if (!ask) return "";
  if (ask.dismissed) return "Dismissed";
  if (!ask.answers) return "";
  return ask.questions.flatMap((q) => ask.answers?.[q.question] || []).join(" · ");
}
