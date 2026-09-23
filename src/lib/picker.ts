/** Arrow-key movement through a list: held to its ends, and 0 while the list is empty. */
export function moveCursor(cursor: number, delta: number, count: number): number {
  return Math.max(0, Math.min(cursor + delta, count - 1));
}
