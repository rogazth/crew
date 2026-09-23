import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./providers";
import type { Autonomy, Session } from "./types";

export type AgentDraft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  notifications: boolean;
  autonomy: Autonomy;
};

export const EMPTY_DRAFT: AgentDraft = {
  name: "",
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  description: "",
  notifications: true,
  autonomy: "ask",
};

/** An edit starts from the session; a new agent starts empty, on the default provider and model. */
export function draftOf(session: Session | null, fallback: Partial<AgentDraft>): AgentDraft {
  if (!session) return { ...EMPTY_DRAFT, ...fallback };
  return {
    name: session.name,
    provider: session.provider,
    model: session.model || DEFAULT_MODEL,
    description: session.description,
    notifications: session.notifications,
    autonomy: session.autonomy,
  };
}

/** The names a new agent cannot take: every agent's, terminals aside. */
export function agentNames(sessions: Session[]): string[] {
  return sessions.flatMap((session) => (session.kind === "agent" ? [session.name] : []));
}

/** Names are unique among agents regardless of case; the agent being edited may keep its own. */
export function nameError(
  name: string,
  existingNames: string[],
  current: string | undefined,
): { taken: boolean; error: string | null } {
  if (!name) return { taken: false, error: "Name is required" };
  const lower = name.toLowerCase();
  const taken = existingNames.some((n) => n.toLowerCase() === lower && n !== current);
  return { taken, error: taken ? "An agent with this name already exists" : null };
}

/**
 * A taken name shows as it is typed, a missing one only after a submit, and
 * neither while saving or closing: the save itself adds the name to the list.
 */
export function shownError({
  error,
  taken,
  submitted,
  busy,
}: {
  error: string | null;
  taken: boolean;
  submitted: boolean;
  busy: boolean;
}): string | undefined {
  if (busy || !(taken || submitted)) return undefined;
  return error ?? undefined;
}
