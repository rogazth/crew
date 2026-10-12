/** How a confirmed action ended: done, asking something else instead, or refused with what to show. */
export type Settled<T> = { kind: "done" } | { kind: "ask"; next: T } | { kind: "failed"; error: string };

/** Waits on an action a prompt started: what it resolves to is the prompt's next step. */
export async function settle<T>(action: Promise<void | T>): Promise<Settled<T>> {
  try {
    const next = await action;
    return next ? { kind: "ask", next } : { kind: "done" };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** A prompt's words; the caller supplies what confirming does. */
export type Prompt = { title: string; description: string; action: string };

/** Files whose unsaved edits go, as one sentence of a prompt; empty when there are none. */
export function unsavedCost(files: string[]): string {
  const [only] = files;
  if (!only) return "";
  return `${files.length === 1 ? `"${only}" has` : `${files.length} files have`} unsaved changes, which are lost.`;
}

/**
 * What closing `count` tabs asks first, once for the whole batch: nothing
 * unless it loses a file's unsaved edits. A terminal's process is no reason:
 * closing a session's tab leaves its CLI running, and a shell holds nothing.
 */
export function closePrompt(count: number, unsaved: string[]): Prompt | null {
  const [file] = unsaved;
  if (!file) return null;
  if (count === 1) return { title: `Close "${file}"?`, description: "Unsaved changes are lost.", action: "Discard" };
  return { title: `Close ${count} tabs?`, description: unsavedCost(unsaved), action: "Close" };
}

/** How many of a session's running entries a prompt names before it counts the rest. */
const NAMED_RUNNING = 4;

/**
 * What restarting a session asks while work it started runs in the background:
 * that work stops with the CLI, and the conversation is kept. `running` names
 * each entry as the panel does.
 */
export function restartPrompt(running: string[]): Prompt {
  const named = running.slice(0, NAMED_RUNNING).join(", ");
  const more = running.length > NAMED_RUNNING ? ` and ${running.length - NAMED_RUNNING} more` : "";
  return {
    title: "Restart this session?",
    description: `Running in the background: ${named}${more}. It stops with the CLI; the conversation is kept.`,
    action: "Restart",
  };
}
