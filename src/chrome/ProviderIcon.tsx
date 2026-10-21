import claude from "../assets/providers/claude.svg";
import codex from "../assets/providers/codex.svg";
import cursor from "../assets/providers/cursor.svg";
import grok from "../assets/providers/grok.svg";
import opencode from "../assets/providers/opencode.svg";
import type { ProviderId } from "../lib/providers";

const MARKS: Record<ProviderId, string> = { claude, cursor, codex, opencode, grok };

export function ProviderIcon({
  provider,
  className = "size-4",
}: {
  provider: string;
  className?: string;
}) {
  const src = MARKS[provider as ProviderId];
  if (!src) return <span className={`${className} shrink-0`} />;
  // A single-colour glyph (cursor, grok) would pin to black as an <img>.
  // Painting it as a mask lets it follow the theme's icon colour.
  if (provider === "cursor" || provider === "grok") {
    return (
      <span
        aria-hidden
        className={`${className} shrink-0 bg-icon`}
        style={{
          WebkitMask: `url("${src}") center / contain no-repeat`,
          mask: `url("${src}") center / contain no-repeat`,
        }}
      />
    );
  }
  return (
    <img src={src} alt="" aria-hidden className={`${className} shrink-0`} />
  );
}
