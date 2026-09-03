import { providerOf } from "./providers";
import type { Session } from "./types";

export type ClaudeTheme = "light" | "dark";

type Options = {
  /** The provider already has a transcript for this id. */
  resume: boolean;
  theme: ClaudeTheme;
};

/**
 * argv for the provider CLI that fills a session's terminal. Crew's session id
 * doubles as the provider's, so the same id resumes on every later launch.
 * Claude paints from its own configured theme and never asks the terminal, so
 * the theme is forced to match the app.
 */
export function sessionCommand(session: Session, { resume, theme }: Options): string[] {
  const binary = providerOf(session.provider)?.binary ?? session.provider;
  if (session.provider !== "claude") return [binary];
  const argv = [binary, "--settings", JSON.stringify({ theme })];
  if (resume) return [...argv, "--resume", session.id];
  argv.push("--session-id", session.id, "--name", session.name);
  if (session.model) argv.push("--model", session.model);
  return argv;
}
