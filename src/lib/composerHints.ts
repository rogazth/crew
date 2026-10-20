/** One key hint under the composer: the key, as a `kbd`, and what it does. */
export type ComposerHint = { key: string; does: string };

/**
 * The key hints at the right of the status line under the composer. While a
 * turn runs the keys do something other than they seem to (Esc stops it, ↵
 * adds to it or queues); an idle composer only says that ⇧Tab steps the
 * effort, when the session has levels to step.
 */
export function composerHints({
  working,
  escBack,
  whileWorking,
  stepsEffort = false,
}: {
  working: boolean;
  escBack: boolean;
  whileWorking?: "steer" | "queue" | undefined;
  stepsEffort?: boolean;
}): ComposerHint[] {
  const effort: ComposerHint[] = stepsEffort ? [{ key: "⇧Tab", does: "effort" }] : [];
  if (!working) return effort;
  const hints: ComposerHint[] = [{ key: "esc", does: escBack ? "back" : "stop" }];
  if (whileWorking === "steer") hints.push({ key: "↵", does: "add to the turn" }, { key: "⌘↵", does: "next turn" });
  if (whileWorking === "queue") hints.push({ key: "↵", does: "queue" });
  return [...hints, ...effort];
}
