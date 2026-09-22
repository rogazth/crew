const busy = new Set<string>();

/**
 * Whether a terminal still has something running, which is not what its status
 * says: the status is an indicator for the tabs you are *not* looking at, and
 * opening a tab clears it to idle. Closing one asks the fact instead.
 */
export function setBusy(sessionId: string, value: boolean): void {
  if (value) busy.add(sessionId);
  else busy.delete(sessionId);
}

export function isBusy(sessionId: string): boolean {
  return busy.has(sessionId);
}
