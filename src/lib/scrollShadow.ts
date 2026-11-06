/**
 * The fade at an edge there is more content past, as long as what is left
 * there up to its full size: it thins out as the end comes up instead of
 * snapping off. The flags (`data-fade-top`, `data-fade-bottom`) say whether
 * there is any; the lengths are what `.crew-scroll-shadow` draws.
 */
export function scrollShadow(el: HTMLElement) {
  const size = parseFloat(getComputedStyle(el).getPropertyValue("--fade-size")) || 40;
  const above = Math.max(0, el.scrollTop);
  const below = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
  const top = above > 1;
  const bottom = below > 1;
  if (el.hasAttribute("data-fade-top") !== top) el.toggleAttribute("data-fade-top", top);
  if (el.hasAttribute("data-fade-bottom") !== bottom) el.toggleAttribute("data-fade-bottom", bottom);
  el.style.setProperty("--fade-top", `${top ? Math.min(size, above) : 0}px`);
  el.style.setProperty("--fade-bottom", `${bottom ? Math.min(size, below) : 0}px`);
}
