import { move } from "@dnd-kit/helpers";

export type DropEvent = Parameters<typeof move>[1] & { canceled: boolean };

/** The id order to persist after a drop, or null when the drop changes nothing. */
export function droppedOrder(ids: string[], event: DropEvent, disabled = false): string[] | null {
  if (event.canceled || disabled) return null;
  const next = move(ids, event);
  if (next.length === ids.length && next.every((id, index) => id === ids[index])) return null;
  return next;
}
