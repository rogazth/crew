export const AGENT_THEMES = [
  { id: "default", label: "Default" },
  { id: "timeline", label: "Timeline" },
] as const;

export type AgentThemeId = (typeof AGENT_THEMES)[number]["id"];

export const DEFAULT_AGENT_THEME: AgentThemeId = "default";

export function parseAgentTheme(raw: string | null): AgentThemeId {
  return AGENT_THEMES.some((theme) => theme.id === raw)
    ? (raw as AgentThemeId)
    : DEFAULT_AGENT_THEME;
}
