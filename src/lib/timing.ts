/**
 * A save that returns instantly reads as if nothing happened. Holding the spinner
 * this long lets the change register; 300-500ms is the usual range for a min
 * loading state, below which it flashes and above which it reads as slow.
 */
export const MIN_SAVE_MS = 400;
