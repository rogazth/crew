/** The name a rename commits: trimmed, not empty, and not the one it started from. Null means no change. */
export function renamedTo(initial: string, value: string): string | null {
  const name = value.trim();
  return name && name !== initial ? name : null;
}
