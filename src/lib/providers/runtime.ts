import type { Answers, ApprovalDecision, HarnessEvent } from "../blocks";
import type { Autonomy } from "../types";
import { claudeRuntime } from "../claudeTurn";
import { codexRuntime } from "../codexTurn";
import { cursorRuntime } from "../cursorTurn";

export type TurnInput = {
  sessionId: string;
  cwd: string;
  model: string;
  name: string;
  description: string;
  autonomy: Autonomy;
  resume?: string | null;
  /** Start a new vendor session instead of resuming: the episode is cut here. */
  fresh?: boolean;
  text: string;
  files?: string[];
  onEvent: (event: HarnessEvent) => void;
};

/** What Crew asks of a provider. Rust supervises processes; this is the protocol side. */
export type ProviderRuntime = {
  send(input: TurnInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  respondApproval(sessionId: string, requestId: number, decision: ApprovalDecision): void;
  /** `null` dismisses: the provider gets a deny and carries on without answers. */
  respondQuestion(sessionId: string, requestId: number, answers: Answers | null): void;
  isLive(sessionId: string): boolean;
};

const RUNTIMES: Record<string, ProviderRuntime> = {
  claude: claudeRuntime,
  codex: codexRuntime,
  cursor: cursorRuntime,
};

export function runtimeFor(providerId: string): ProviderRuntime {
  const runtime = RUNTIMES[providerId];
  if (!runtime) throw new Error(`${providerId} agents are not wired up yet. Pick Claude for now.`);
  return runtime;
}

export function hasRuntime(providerId: string): boolean {
  return providerId in RUNTIMES;
}

export function anyLive(sessionId: string): boolean {
  return Object.values(RUNTIMES).some((runtime) => runtime.isLive(sessionId));
}

export async function stopEverywhere(sessionId: string): Promise<void> {
  await Promise.all(Object.values(RUNTIMES).map((runtime) => runtime.stop(sessionId)));
}
