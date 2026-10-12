/**
 * A first message written before its session existed, as home's composer
 * does: the chat sends it as the session's first turn. It is gone after, so a
 * reopened tab resumes the conversation instead of asking again.
 */
const prompts = new Map<string, string>();

export function setFirstPrompt(sessionId: string, text: string): void {
  prompts.set(sessionId, text);
}

export function peekFirstPrompt(sessionId: string): string | undefined {
  return prompts.get(sessionId);
}

export function clearFirstPrompt(sessionId: string): void {
  prompts.delete(sessionId);
}
