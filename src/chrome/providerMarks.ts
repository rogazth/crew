import claude from "../assets/providers/claude.svg";
import codex from "../assets/providers/codex.svg";
import cursor from "../assets/providers/cursor.svg";
import grok from "../assets/providers/grok.svg";
import opencode from "../assets/providers/opencode.svg";
import type { ProviderId } from "../lib/providers";

const MARKS: Record<ProviderId, string> = { claude, cursor, codex, opencode, grok };

/**
 * A provider's logo, and whether it is drawn as a mask: a single-colour glyph
 * (cursor, grok) would pin to black as an image, as a mask it follows the
 * theme's icon colour.
 */
export function providerMark(provider: string): { src: string; mask: boolean } | null {
  const src = MARKS[provider as ProviderId];
  return src ? { src, mask: provider === "cursor" || provider === "grok" } : null;
}
