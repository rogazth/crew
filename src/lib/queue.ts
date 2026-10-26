import type { Block } from "./blocks";
import { letterIdOf } from "./letters";
import type { ThreadLetter } from "./protocol";

/**
 * What the user sent while a turn ran and the transcript does not show yet:
 * a steer the turn has not read, or a message waiting for the turn to end.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  files: string[];
  /** Taken into the running turn, not read yet; it can no longer be edited. */
  steering: boolean;
};

/** CLIs that read a message at their next step instead of after the turn (decision 31). */
const STEERABLE = new Set(["claude", "codex"]);

/** What Enter does with a message written while a turn runs. */
export function whileWorkingOf(provider: string): "steer" | "queue" {
  return STEERABLE.has(provider) ? "steer" : "queue";
}

/**
 * The user's own messages still in the box, first to go first: what the
 * transcript already shows is left out (a turn's own letter, a steer whose
 * echo came). Steers come first: they are already in the turn.
 */
export function userQueue(pending: readonly ThreadLetter[], blocks: readonly Block[]): QueuedMessage[] {
  const shown = new Set(blocks.map(letterIdOf).filter((id): id is string => id !== undefined));
  const own = pending
    .filter((letter) => letter.from.kind === "user" && !shown.has(letter.id))
    .map((letter) => ({ id: letter.id, text: letter.text, files: letter.files ?? [], steering: letter.queue === "steering" }));
  return [...own.filter((message) => message.steering), ...own.filter((message) => !message.steering)];
}

/**
 * The letters the transcript draws as queued bubbles at its foot: everyone
 * else's, and the user's steers, which the running turn has taken and reads
 * at its next step. The user's waiting messages sit above the composer.
 */
export function transcriptPending(pending: readonly ThreadLetter[]): ThreadLetter[] {
  return pending.filter((letter) => letter.from.kind !== "user" || letter.queue === "steering");
}

/** The waiting ids after moving `id` one place up (-1) or down (1); steers keep their place. */
export function moved(queue: readonly QueuedMessage[], id: string, step: -1 | 1): string[] {
  const waiting = queue.filter((message) => !message.steering).map((message) => message.id);
  const at = waiting.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= waiting.length) return waiting;
  [waiting[at], waiting[to]] = [waiting[to]!, waiting[at]!];
  return waiting;
}
