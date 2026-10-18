import type { Access } from "./providers";

/** The access ⇧Tab moves to in the chat: the provider's next mode, full included, then round to the first. */
export function nextAccess(current: string, offered: Access[]): Access | null {
  if (offered.length < 2) return null;
  const at = offered.indexOf(current as Access);
  return offered[(at + 1) % offered.length] ?? null;
}
