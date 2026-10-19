import type { Effort } from "./providers";

/** The effort ⇧Tab moves to in the chat: the model's next level, then round to the lowest. */
export function nextEffort(current: string, offered: readonly Effort[]): Effort | null {
  if (offered.length < 2) return null;
  const at = offered.indexOf(current as Effort);
  return offered[(at + 1) % offered.length] ?? null;
}
