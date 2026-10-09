import type { Access } from "./providers";

/** The access ⇧Tab moves to in the chat: the provider's next mode, short of full. */
export function nextAccess(current: string, offered: Access[]): Access | null {
  const ring: Access[] = offered.filter((access) => access !== "full");
  if (ring.length < 2) return null;
  const at = ring.indexOf(current as Access);
  return ring[(at + 1) % ring.length] ?? null;
}
