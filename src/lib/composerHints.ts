/** One key hint under the composer: the key, as a `kbd`, and what it does. */
export type ComposerHint = { key: string; does: string };

/**
 * The key hints at the right of the status line under the composer: that ⇧Tab
 * steps the effort, when the session has levels to step, and in a thread with
 * a turn running that Esc goes back. Sending is the same with a turn running.
 */
export function composerHints({
  working,
  escBack,
  stepsEffort = false,
}: {
  working: boolean;
  escBack: boolean;
  stepsEffort?: boolean;
}): ComposerHint[] {
  const effort: ComposerHint[] = stepsEffort ? [{ key: "⇧Tab", does: "effort" }] : [];
  if (!working) return effort;
  return escBack ? [{ key: "esc", does: "back" }, ...effort] : effort;
}
