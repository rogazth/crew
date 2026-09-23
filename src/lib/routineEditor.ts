import { isValidCron } from "./cron";
import type { RoutineDraft } from "./routines";
import type { Session } from "./types";

/** Savable: a title, instructions, an agent, and a cron that parses when it is one. */
export function routineValid(draft: RoutineDraft): boolean {
  const cronOk = draft.schedule.kind !== "cron" || isValidCron(draft.schedule.expression);
  return draft.name.trim() !== "" && draft.prompt.trim() !== "" && draft.sessionId !== "" && cronOk;
}

/** Moving the routine to another workspace hands it to that workspace's first agent. */
export function withAgentFrom(draft: RoutineDraft, agents: Session[]): RoutineDraft {
  return agents.some((agent) => agent.id === draft.sessionId)
    ? draft
    : { ...draft, sessionId: agents[0]?.id ?? "" };
}

export function runFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
