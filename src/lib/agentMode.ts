import type { SessionKind } from "./types";

/**
 * How a new agent runs: in Crew's chat, driven over the provider's structured
 * output, or in the provider's own CLI in a terminal tab.
 */
export type AgentMode = "chat" | "cli";

export const AGENT_MODES: { value: AgentMode; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "cli", label: "Terminal" },
];

export const DEFAULT_AGENT_MODE: AgentMode = "chat";

export function parseAgentMode(raw: string | null | undefined): AgentMode {
  return raw === "cli" ? "cli" : DEFAULT_AGENT_MODE;
}

/** The session a new agent is made as. */
export function agentKind(mode: AgentMode): SessionKind {
  return mode === "cli" ? "terminal" : "agent";
}
