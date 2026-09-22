import { providerOf } from "./providers";
import type { Session } from "./types";

export type ClaudeTheme = "light" | "dark";

type Options = {
  /** Claude already has a transcript for this id. Other providers resume by `providerSessionId`. */
  resume: boolean;
  theme: ClaudeTheme;
};

/**
 * argv for the provider CLI that fills a session's terminal. Crew's session id
 * doubles as the provider's, so the same id resumes on every later launch.
 * `--name` is deliberately absent: it lands as a `custom-title`, which outranks
 * the name Claude generates, so passing one means Claude never names anything.
 * Claude paints from its own configured theme and never asks the terminal, so
 * the theme is forced to match the app.
 */
export function sessionCommand(session: Session, { resume, theme }: Options): string[] {
  const provider = providerOf(session.provider);
  if (!provider) return [session.provider];
  if (provider.binding !== "own") {
    const bound = session.providerSessionId;
    return [
      provider.binary,
      ...(bound ? provider.resumeArgs(bound) : []),
      ...(session.model ? [provider.modelFlag, session.model] : []),
    ];
  }
  const argv = [provider.binary, "--settings", JSON.stringify({ theme })];
  if (resume) return [...argv, "--resume", session.id];
  argv.push("--session-id", session.id);
  if (session.model) argv.push("--model", session.model);
  return argv;
}
