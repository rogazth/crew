import { claudeSessionId } from "./claudeStorage";
import { providerOf } from "./providers";
import type { Session } from "./types";

export type ClaudeTheme = "light" | "dark";

type Options = {
  /** Claude already has a transcript for its current session. Other providers resume by `providerSessionId`. */
  resume: boolean;
  theme: ClaudeTheme;
  /** Settings bypasses permissions: the CLI runs without asking. */
  bypass?: boolean;
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
export function sessionCommand(session: Session, { resume, theme, bypass = false }: Options): string[] {
  const provider = providerOf(session.provider);
  if (!provider) return [session.provider];
  const bypassing = bypass ? [provider.bypassFlag] : [];
  if (provider.binding !== "own") {
    const bound = session.providerSessionId;
    return [
      provider.binary,
      ...(bound ? provider.resumeArgs(bound) : []),
      ...(session.model ? [provider.modelFlag, session.model] : []),
      ...bypassing,
    ];
  }
  const argv = [provider.binary, "--settings", JSON.stringify({ theme, hooks: bindHooks(session.id) })];
  const id = claudeSessionId(session);
  if (resume) return [...argv, "--resume", id, ...bypassing];
  argv.push("--session-id", id);
  if (session.model) argv.push("--model", session.model);
  return [...argv, ...bypassing];
}

/** What the chat follows a session's CLI by: its turns, and what it stops to ask. */
const LIVE_HOOKS = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/**
 * Hands each hook's stdin to the daemon's bind folder, one record per run,
 * written aside and moved in so the daemon never reads half of one; the
 * seconds and the hook's pid name it. SessionStart's `.start` carries Claude's
 * current session id, which a `/clear` changes; every hook's `.hook` (that one
 * included) tells the daemon what the CLI is doing. They print nothing:
 * SessionStart's stdout is added to the model's context, and a permission
 * hook that answers would take the decision from the user.
 */
function bindHooks(crewId: string) {
  const record = (ext: string) =>
    `if [ -n "$CREW_CLAUDE_BIND_DIR" ]; then f="$CREW_CLAUDE_BIND_DIR/${crewId}.$(date +%s)-$$"; cat > "$f.tmp" && mv "$f.tmp" "$f.${ext}"; fi`;
  const live = { hooks: [{ type: "command", command: record("hook") }] };
  return {
    SessionStart: [{ hooks: [{ type: "command", command: record("start") }] }, live],
    ...Object.fromEntries(LIVE_HOOKS.map((event) => [event, [live]])),
  };
}
