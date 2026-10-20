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

/**
 * What a chat's composer holds right now, kept for as long as the chat is
 * mounted, so a fresh session moved to another worktree (a new session that
 * replaces it) can take the draft and the attachments along.
 */
export type Unsent = { draft: string; files: AttachedFile[] };
const unsent = new Map<string, Unsent>();
const carried = new Map<string, Unsent>();

export function noteUnsent(sessionId: string, held: Unsent): void {
  unsent.set(sessionId, held);
}

export function forgetUnsent(sessionId: string): void {
  unsent.delete(sessionId);
}

export function peekUnsent(sessionId: string): Unsent | undefined {
  return unsent.get(sessionId);
}

/** Hands `held` to the chat that opens for `sessionId`. */
export function carryUnsent(sessionId: string, held: Unsent): void {
  if (held.draft || held.files.length > 0) carried.set(sessionId, held);
}

/** What was carried to this session's chat, once. */
export function takeCarried(sessionId: string): Unsent | undefined {
  const held = carried.get(sessionId);
  carried.delete(sessionId);
  return held;
}
