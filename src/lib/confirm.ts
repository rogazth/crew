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

/** What stopping a terminal session asks while its CLI is at work; `label` says how ("is still working"). */
export function stopPrompt(name: string, label: string): Prompt {
  return {
    title: `Stop "${name}"?`,
    description: `It ${label}. Stopping ends its process; the session stays in the sidebar.`,
    action: "Stop",
  };
}
