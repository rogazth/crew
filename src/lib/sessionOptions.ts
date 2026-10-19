import type { Access, Effort } from "./providers";

/** The access ⇧Tab moves to in the chat: the provider's next mode, full included, then round to the first. */
export function nextAccess(current: string, offered: Access[]): Access | null {
  if (offered.length < 2) return null;
  const at = offered.indexOf(current as Access);
  return offered[(at + 1) % offered.length] ?? null;
}

/** The effort ⇧Tab moves to in the redesigned chat: the model's next level, then round to the lowest. */
export function nextEffort(current: string, offered: readonly Effort[]): Effort | null {
  if (offered.length < 2) return null;
  const at = offered.indexOf(current as Effort);
  return offered[(at + 1) % offered.length] ?? null;
}
