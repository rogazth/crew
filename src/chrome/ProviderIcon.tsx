import claude from "../assets/providers/claude.svg";
import codex from "../assets/providers/codex.svg";
import cursor from "../assets/providers/cursor.svg";
import type { ProviderId } from "../lib/providers";

const MARKS: Record<ProviderId, string> = { claude, cursor, codex };

export function ProviderIcon({
  provider,
  className = "size-4",
}: {
  provider: string;
  className?: string;
}) {
  const src = MARKS[provider as ProviderId];
  if (!src) return <span className={`${className} shrink-0`} />;
  return (
    <img src={src} alt="" aria-hidden className={`${className} shrink-0`} />
  );
}
