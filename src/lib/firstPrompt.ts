/**
 * A first message written before its session existed, as home's composer
 * does: the session's first launch hands it to the CLI in the terminal view,
 * and the chat sends it as the first turn in the chat view. It is gone after,
 * so a relaunch resumes the conversation instead of asking again.
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
