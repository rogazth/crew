export type SearchKey = { kind: "close" } | { kind: "step"; delta: 1 | -1 } | null;

/** Escape closes the bar; Enter walks forward and Shift+Enter back. */
export function searchKey(key: string, shiftKey: boolean): SearchKey {
  if (key === "Escape") return { kind: "close" };
  if (key !== "Enter") return null;
  return { kind: "step", delta: shiftKey ? -1 : 1 };
}

/** "3 of 12", or nothing while there are no matches. */
export function matchLabel(results: { index: number; count: number }): string {
  return results.count > 0 ? `${results.index + 1} of ${results.count}` : "";
}
