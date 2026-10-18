/** One key hint under the composer: the key, as a `kbd`, and what it does. */
export type ComposerHint = { key: string; does: string };

/**
 * The key hints at the right of the status line under the composer. They show
 * only while a turn runs, when the keys do something other than they seem to
 * (Esc stops it, ↵ adds to it or queues); an idle composer says nothing.
 */
export function composerHints({
  working,
  escBack,
  whileWorking,
}: {
  working: boolean;
  escBack: boolean;
  whileWorking?: "steer" | "queue" | undefined;
}): ComposerHint[] {
  if (!working) return [];
  const hints: ComposerHint[] = [{ key: "esc", does: escBack ? "back" : "stop" }];
  if (whileWorking === "steer") hints.push({ key: "↵", does: "add to the turn" }, { key: "⌘↵", does: "next turn" });
  if (whileWorking === "queue") hints.push({ key: "↵", does: "queue" });
  return hints;
}
