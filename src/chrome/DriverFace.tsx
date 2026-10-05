import { BotAvatar } from "./BotAvatar";
import { ProviderIcon } from "./ProviderIcon";
import type { Session } from "../lib/types";

/**
 * Whoever drives a browser tab, as its own tab shows it: only a bot has a
 * face; any other session wears its provider's mark.
 */
export function DriverFace({ session, className }: { session: Session; className: string }) {
  return session.kind === "bot" ? (
    <BotAvatar seed={session.id} className={className} />
  ) : (
    <ProviderIcon provider={session.provider} className={className} />
  );
}
