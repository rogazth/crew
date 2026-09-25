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

/** A terminal a close would end, and how the prompt says so ("is still working"). */
export type Running = { name: string; label: string };

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
 * unless it ends a running terminal or loses a file's unsaved edits.
 */
export function closePrompt(count: number, running: Running[], unsaved: string[]): Prompt | null {
  const [terminal] = running;
  const [file] = unsaved;
  if (count === 1 && terminal) {
    return {
      title: `Close "${terminal.name}"?`,
      description: `It ${terminal.label}. Closing the tab ends the process; the session stays in the sidebar.`,
      action: "Close",
    };
  }
  if (count === 1 && file) return { title: `Close "${file}"?`, description: "Unsaved changes are lost.", action: "Discard" };
  if (!terminal && !file) return null;
  const ends = terminal
    ? `${running.length === 1 ? `"${terminal.name}" is` : `${running.length} sessions are`} still running. Closing ends ${running.length === 1 ? "its process" : "their processes"}; the sessions stay in the sidebar.`
    : "";
  return {
    title: `Close ${count} tabs?`,
    description: [ends, unsavedCost(unsaved)].filter(Boolean).join(" "),
    action: "Close",
  };
}
