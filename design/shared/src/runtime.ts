/**
 * The fake daemon. Replays scripted turns as `HarnessEvent`s on a timer so a
 * prototype can show streaming, tool calls, approvals and questions without a
 * backend. Same event vocabulary as the real harness, so the reducer below is
 * the same reducer the app uses.
 */
import type {
  ApprovalDecision,
  AttachedFile,
  Block,
  BlockRole,
  HarnessEvent,
  SessionStatus,
  ThreadState,
  TurnUsage,
} from "./types";
import { threadFor } from "./data/threads";

export type { ThreadState };

// ---------------------------------------------------------------------------
// Reducer — ported from src/lib/blocks.ts
// ---------------------------------------------------------------------------

let counter = 0;
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${(counter += 1)}`;

export function newBlock(role: BlockRole, text = ""): Block {
  return { id: uid(), role, text, at: Date.now() };
}

export function settleStreaming(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.streaming ? { ...b, streaming: false } : b));
}

export function settleTurn(blocks: Block[], tools: "completed" | "interrupted"): Block[] {
  return settleStreaming(blocks).map((block) => {
    if (block.tool?.status === "pending") return { ...block, tool: { ...block.tool, status: tools } };
    if (block.approval && !block.approval.decided) {
      return { ...block, approval: { ...block.approval, decided: "deny" as ApprovalDecision } };
    }
    if (block.question && !block.question.answers && !block.question.dismissed) {
      return { ...block, question: { ...block.question, dismissed: true } };
    }
    return block;
  });
}

function appendStreaming(blocks: Block[], role: "assistant" | "reasoning", text: string): Block[] {
  const last = blocks.at(-1);
  if (last?.role === role && last.streaming) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...settleStreaming(blocks), { ...newBlock(role, text), streaming: true }];
}

function lastIndex(blocks: Block[], match: (b: Block) => boolean): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) if (match(blocks[i]!)) return i;
  return -1;
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
      if (!event.usage || settled.length === 0) return settled;
      const index = settled.length - 1;
      return settled.map((b, i) => (i === index ? { ...b, usage: event.usage, at: Date.now() } : b));
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
      const at = lastIndex(
        blocks,
        (b) => b.approval?.requestId === event.requestId && b.approval.decided === undefined,
      );
      if (at < 0) return blocks;
      const decided: ApprovalDecision = event.decision === "cancelled" ? "deny" : event.decision;
      const next = blocks.slice();
      next[at] = { ...blocks[at]!, approval: { ...blocks[at]!.approval!, decided } };
      return next;
    }
    case "question.requested": {
      const settled = settleStreaming(blocks);
      const first = event.questions[0];
      return [
        ...settled,
        {
          ...newBlock("question", first?.header || first?.question || "Question"),
          question: { requestId: event.requestId, questions: event.questions },
        },
      ];
    }
    case "question.resolved": {
      const at = lastIndex(
        blocks,
        (b) =>
          b.question?.requestId === event.requestId &&
          b.question.answers === undefined &&
          b.question.dismissed !== true,
      );
      if (at < 0) return blocks;
      const next = blocks.slice();
      next[at] = {
        ...blocks[at]!,
        question: {
          ...blocks[at]!.question!,
          ...(event.answers ? { answers: event.answers } : { dismissed: true }),
        },
      };
      return next;
    }
    case "session.error":
      return [...settleTurn(blocks, "interrupted"), newBlock("system", event.message)];
    case "session.ended":
      return settleTurn(blocks, "interrupted");
    case "session.note":
      return [...settleStreaming(blocks), newBlock("system", event.message)];
    case "user.message":
      return [
        ...blocks,
        {
          ...newBlock("user", event.text),
          ...(event.hidden ? { hidden: true } : {}),
          ...(event.files?.length ? { files: event.files } : {}),
          ...(event.fromAgent ? { fromAgent: event.fromAgent } : {}),
        },
      ];
    case "system.message":
      return [...blocks, newBlock("system", event.text)];
    default:
      return blocks;
  }
}

// ---------------------------------------------------------------------------
// Scripted turns
// ---------------------------------------------------------------------------

type Step = { after: number; event: HarnessEvent };

const USAGE: TurnUsage = {
  inputTokens: 24_600,
  outputTokens: 480,
  costUsd: 0.1284,
  durationMs: 18_400,
};

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

/** Streams a body out word by word, roughly 45 words a second with jitter. */
function stream(
  steps: Step[],
  at: number,
  text: string,
  kind: "message" | "reasoning" = "message",
): number {
  let t = at;
  for (const word of words(text)) {
    t += 14 + Math.random() * 34;
    steps.push({
      after: t,
      event:
        kind === "message"
          ? { type: "message.delta", text: word }
          : { type: "reasoning.delta", text: word },
    });
  }
  return t;
}

const REPLY_PLAIN = `Sí. El problema no es el spinner, es que no hay modelo de elevación:
los botones de Kumo traen relieve propio y el chrome que escribimos es plano, así que
cada componente decide por su cuenta si flota o no.

Tres cosas, en orden de costo:

1. **Una escala de elevación** — cuatro niveles y nada fuera de ellos. El botón, el
menú y la fila del sidebar tienen que elegir de la misma lista.
2. **Un solo set de iconos.** Hoy conviven \`chrome/icons.tsx\` a stroke 1.75 y Phosphor
con sus propios pesos; se nota en cualquier fila que tenga los dos.
3. **El estado \`working\` deja de ser un spinner.** Un spinner dice "esto está
cargando", que no es lo que hace un agente pensando.

Lo tercero es el más barato y el que más se ve.`;

const REASONING_PLAIN = `The user is asking why the chrome feels inconsistent. The honest answer
is that there are two design languages in the window: Kumo's, which ships embossed
controls, and the hand-written Tailwind chrome, which is flat. Neither is wrong; having
both is. I should name that rather than list symptoms.`;

/**
 * The reply the fake agent gives to anything. Deliberately covers a reasoning
 * stream, a tool phase, and a markdown answer with a list and bold text.
 */
export function scriptedTurn(text: string, files: AttachedFile[] = []): Step[] {
  const steps: Step[] = [];
  let t = 0;
  steps.push({
    after: t,
    event: { type: "user.message", text, ...(files.length ? { files } : {}) },
  });

  t += 420;
  t = stream(steps, t, REASONING_PLAIN, "reasoning");

  t += 300;
  const call1 = `call-${Date.now()}-1`;
  steps.push({
    after: t,
    event: {
      type: "tool.started",
      callId: call1,
      name: "Grep",
      title: "Grep shadow|elevation",
      detail: { kind: "search", query: "shadow|elevation" },
    },
  });
  t += 900;
  steps.push({
    after: t,
    event: {
      type: "tool.updated",
      callId: call1,
      status: "completed",
      detail: { kind: "search", query: "shadow|elevation", matches: 23 },
    },
  });

  t += 250;
  const call2 = `call-${Date.now()}-2`;
  steps.push({
    after: t,
    event: {
      type: "tool.started",
      callId: call2,
      name: "Read",
      title: "Read src/index.css",
      detail: { kind: "file", path: "/Users/you/crew/src/index.css" },
    },
  });
  t += 1_100;
  steps.push({
    after: t,
    event: {
      type: "tool.updated",
      callId: call2,
      status: "completed",
      detail: {
        kind: "file",
        path: "/Users/you/crew/src/index.css",
        lineStart: 1,
        lineEnd: 32,
        preview: `@theme {
  --color-canvas: var(--color-kumo-base);
  --color-sidebar: var(--color-kumo-elevated);
  --color-border: var(--color-kumo-line);
  --radius-chrome: 0.625rem;
}`,
      },
    },
  });

  t += 500;
  t = stream(steps, t, REPLY_PLAIN, "message");
  t += 200;
  steps.push({ after: t, event: { type: "message.completed" } });
  t += 60;
  steps.push({ after: t, event: { type: "turn.completed", usage: USAGE } });
  return steps;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

type Listener = (state: ThreadState) => void;

/**
 * One live thread. `send` replays a scripted turn; `stop` interrupts it the way
 * the real daemon does — pending tools settle as `interrupted`.
 */
export class MockSession {
  private state: ThreadState;
  private listeners = new Set<Listener>();
  private timers: number[] = [];

  constructor(
    readonly id: string,
    blocks: Block[] = threadFor(id),
    status: SessionStatus = "idle",
  ) {
    this.state = { blocks, working: false, status };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  get snapshot(): ThreadState {
    return this.state;
  }

  private emit(next: Partial<ThreadState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  private clear() {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }

  apply(event: HarnessEvent) {
    this.emit({ blocks: applyEvent(this.state.blocks, event) });
  }

  send(text: string, files: AttachedFile[] = []) {
    if (this.state.working) return;
    this.clear();
    this.emit({ working: true, status: "working" });
    const steps = scriptedTurn(text, files);
    for (const step of steps) {
      const timer = window.setTimeout(() => {
        this.apply(step.event);
        if (step === steps.at(-1)) {
          this.clear();
          this.emit({ working: false, status: "done" });
        }
      }, step.after);
      this.timers.push(timer);
    }
  }

  /** A scripted turn that ends by asking for permission instead of answering. */
  sendAndAskApproval(text: string) {
    if (this.state.working) return;
    this.clear();
    this.emit({ working: true, status: "working" });
    const requestId = Math.floor(Math.random() * 10_000);
    const script: Step[] = [
      { after: 0, event: { type: "user.message", text } },
      { after: 400, event: { type: "reasoning.delta", text: "This rewrites a tracked file, so it needs a decision first. " } },
      {
        after: 1_200,
        event: {
          type: "approval.requested",
          requestId,
          name: "Edit",
          title: "Edit src/index.css",
          input: { file_path: "/Users/you/crew/src/index.css" },
        },
      },
    ];
    for (const step of script) {
      this.timers.push(window.setTimeout(() => this.apply(step.event), step.after));
    }
    this.timers.push(
      window.setTimeout(() => this.emit({ working: false, status: "needs-input" }), 1_300),
    );
  }

  /** A scripted turn that ends in an AskUserQuestion card. */
  sendAndAsk(text: string) {
    if (this.state.working) return;
    this.clear();
    this.emit({ working: true, status: "working" });
    const requestId = Math.floor(Math.random() * 10_000);
    this.apply({ type: "user.message", text });
    this.timers.push(
      window.setTimeout(() => {
        this.apply({
          type: "question.requested",
          requestId,
          questions: [
            {
              question: "¿Qué escala de elevación usamos?",
              header: "Elevación",
              multiSelect: false,
              options: [
                { label: "Plana", description: "Sin sombras. Todo se separa por tono y hairline." },
                { label: "Dos niveles", description: "Superficie y overlay, nada más." },
                { label: "Cuatro niveles", description: "Fila, control, popover, modal." },
              ],
            },
          ],
        });
        this.emit({ working: false, status: "needs-input" });
      }, 900),
    );
  }

  approve(requestId: number, decision: ApprovalDecision) {
    this.apply({ type: "approval.resolved", requestId, decision });
    if (decision === "deny") {
      this.emit({ working: false, status: "idle" });
      return;
    }
    this.emit({ working: true, status: "working" });
    const callId = `call-${Date.now()}`;
    this.timers.push(
      window.setTimeout(() => {
        this.apply({
          type: "tool.started",
          callId,
          name: "Edit",
          title: "Edit src/index.css",
          detail: { kind: "edit", path: "/Users/you/crew/src/index.css" },
        });
      }, 300),
    );
    this.timers.push(
      window.setTimeout(() => {
        this.apply({
          type: "tool.updated",
          callId,
          status: "completed",
          detail: { kind: "edit", path: "/Users/you/crew/src/index.css", added: 12, removed: 4 },
        });
      }, 1_400),
    );
    let t = 1_700;
    const reply =
      "Listo. La escala de elevación quedó en `index.css` como cuatro tokens, y el botón, el menú y la fila del sidebar ahora eligen de ahí.";
    for (const word of words(reply)) {
      t += 22 + Math.random() * 30;
      this.timers.push(
        window.setTimeout(() => this.apply({ type: "message.delta", text: word }), t),
      );
    }
    this.timers.push(
      window.setTimeout(() => {
        this.apply({ type: "turn.completed", usage: USAGE });
        this.emit({ working: false, status: "done" });
      }, t + 200),
    );
  }

  answer(requestId: number, answers: Record<string, string> | null) {
    this.apply({ type: "question.resolved", requestId, answers });
    this.emit({ working: false, status: "idle" });
  }

  stop() {
    this.clear();
    this.emit({ blocks: settleTurn(this.state.blocks, "interrupted"), working: false, status: "idle" });
  }

  /** A letter arriving from another agent while you were reading something else. */
  receiveFrom(agent: { id: string; name: string }, text: string) {
    this.apply({ type: "user.message", text, fromAgent: agent });
  }

  dispose() {
    this.clear();
    this.listeners.clear();
  }
}

const registry = new Map<string, MockSession>();

export function sessionRuntime(id: string, status?: SessionStatus): MockSession {
  let found = registry.get(id);
  if (!found) {
    found = new MockSession(id, threadFor(id), status);
    registry.set(id, found);
  }
  return found;
}

export function resetRuntime() {
  for (const session of registry.values()) session.dispose();
  registry.clear();
}
