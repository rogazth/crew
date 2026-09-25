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
