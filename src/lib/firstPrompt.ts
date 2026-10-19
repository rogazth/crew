import type { AttachedFile } from "./blocks";

/**
 * A first message written before its session existed, as home's composer
 * does: the chat sends it as the session's first turn. It is gone after, so a
 * reopened tab resumes the conversation instead of asking again.
 */
const prompts = new Map<string, string>();
const attached = new Map<string, AttachedFile[]>();

export function setFirstPrompt(sessionId: string, text: string, files: AttachedFile[] = []): void {
  prompts.set(sessionId, text);
  if (files.length > 0) attached.set(sessionId, files);
}

/** The files that went with the first message. */
export function peekFirstFiles(sessionId: string): AttachedFile[] {
  return attached.get(sessionId) ?? [];
}

export function peekFirstPrompt(sessionId: string): string | undefined {
  return prompts.get(sessionId);
}

export function clearFirstPrompt(sessionId: string): void {
  prompts.delete(sessionId);
  attached.delete(sessionId);
}
