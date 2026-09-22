import type { Session } from "./types";

/** `/clear` moves Claude to a new session, which Crew learns and binds. */
export function claudeSessionId(session: Session): string {
  return session.providerSessionId ?? session.id;
}

/**
 * Where Claude Code keeps a conversation. `--resume` fails when it is missing
 * and `--session-id` fails when it exists, so the launcher has to look first.
 * Claude never told us this layout; it is observed from ~/.claude/projects.
 */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${home.replace(/\/$/, "")}/.claude/projects/${slug}/${sessionId}.jsonl`;
}
