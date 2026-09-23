import { isOpen, type Block, type TurnUsage } from "./blocks";
import { clock, duration } from "./time";

/** How close to the bottom still counts as following the conversation. */
export const NEAR_BOTTOM_PX = 16;

/** The pending tool row already is the live state; Thinking only fills a true gap. */
export function showThinking(blocks: Block[], working: boolean): boolean {
  if (!working) return false;
  const last = blocks.at(-1);
  if (!last) return true;
  if ((last.role === "assistant" || last.role === "reasoning") && last.streaming && last.text) return false;
  return !isOpen(last);
}

type Box = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** The reader is at the bottom, so new text should keep them there. */
export function isPinned(box: Box): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * Where the scroller goes after the content changed. A tab behind another one
 * is display:none, where every measurement reads 0; writing one there is what
 * lands the reader at the top of a year of history the moment the tab is
 * shown. Reading something further up: history loading above, or a resync
 * trimming it, must leave that line where it was.
 */
export function placeScroll(box: Omit<Box, "scrollTop">, pinned: boolean, fromBottom: number): number | null {
  if (box.clientHeight === 0) return null;
  return pinned ? box.scrollHeight : box.scrollHeight - fromBottom;
}

/** The first line with something on it: what a folded letter from another agent shows. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

/** "Worked for 2m · 5:40 PM": what closes a turn, or null when there is nothing to say. */
export function footerLine(usage: TurnUsage, at?: number): string | null {
  const parts: string[] = [];
  if (usage.durationMs !== undefined) parts.push(`Worked for ${duration(usage.durationMs)}`);
  if (at !== undefined) parts.push(clock(at));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Tokens and cost, for the footer's tooltip. */
export function usageDetail(usage: TurnUsage): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`${compactCount(usage.inputTokens ?? 0)} in · ${compactCount(usage.outputTokens ?? 0)} out`);
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
