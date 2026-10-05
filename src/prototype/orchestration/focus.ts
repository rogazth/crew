// PROTOTYPE — taking the reader to a row by scroll position alone: its top just under the edge.

/** How far below the scroller's top edge the row lands: room for what floats over it. */
const OFFSET = 16;

/** Puts `row` near the top of `scroller` without moving anything else on the page. */
export function scrollToRow(scroller: HTMLElement, row: Element, offset = OFFSET) {
  // Not scrollIntoView: that also scrolls every clipped ancestor, which is the jump.
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
}

/** Back in the transcript, at a checkpoint. The thread closes first; the row is there on the next frame. */
export function showInChat(id: string) {
  requestAnimationFrame(() => {
    const scroller = document.querySelector<HTMLElement>("[data-proto-scroller]");
    const row = scroller?.querySelector(`[data-block="${CSS.escape(id)}"]`);
    if (scroller && row) scrollToRow(scroller, row, 24);
  });
}
