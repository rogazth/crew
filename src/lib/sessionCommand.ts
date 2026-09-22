import { claudeSessionId } from "./claudeStorage";
import { providerOf } from "./providers";
import type { Session } from "./types";

export type ClaudeTheme = "light" | "dark";

type Options = {
  /** Claude already has a transcript for its current session. Other providers resume by `providerSessionId`. */
  resume: boolean;
  theme: ClaudeTheme;
};

/**
 * argv for the provider CLI that fills a session's terminal. Crew's session id
 * doubles as Claude's until a `/clear` moves Claude to a new one, which the
 * SessionStart hook reports back; the bound id resumes on every later launch.
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
  const argv = [provider.binary, "--settings", JSON.stringify({ theme, hooks: bindHooks(session.id) })];
  const id = claudeSessionId(session);
  if (resume) return [...argv, "--resume", id];
  argv.push("--session-id", id);
  if (session.model) argv.push("--model", session.model);
  return argv;
}

/**
 * Hands the hook's stdin, which carries Claude's current session id, to the
 * daemon's bind folder. It must print nothing: SessionStart stdout is added to
 * the model's context.
 */
function bindHooks(crewId: string) {
  const command = `if [ -n "$CREW_CLAUDE_BIND_DIR" ]; then cat > "$CREW_CLAUDE_BIND_DIR/${crewId}.json"; fi`;
  return { SessionStart: [{ hooks: [{ type: "command", command }] }] };
}
