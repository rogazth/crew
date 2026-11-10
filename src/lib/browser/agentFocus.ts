/**
 * An agent's click reaches its page as a real one, and a real mouse press
 * hands the page the window's keyboard: the person typing in a composer
 * would lose it to a tab they may not even be looking at. Main says when an
 * agent's click is on its way; a page that takes the focus while it lands
 * gives it straight back to where the person had it.
 */

/** Long enough for the click to land and the page to take the focus; short enough that the person's own click is theirs. */
const SHIELD_MS = 1500;

type Shield = { until: number; back: Element | null };

const shields = new Map<number, Shield>();
let watching = false;

const webContentsIdOf = (el: Element): number | null => {
  try {
    return (el as Element & { getWebContentsId(): number }).getWebContentsId();
  } catch {
    return null;
  }
};

/** When a page that took the focus is looked for, after the click was announced. */
const CHECKS_MS = [0, 50, 150, 400, 800, 1200];

/**
 * The page taking the focus is not heard as a focus on its element, and when
 * nothing had it before, nothing is heard leaving either. So a page holding
 * it is looked for while the click lands, and as soon as the focus leaves
 * where the person had it.
 */
function check() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.tagName === "WEBVIEW") returnFocus(active, webContentsIdOf(active));
}

const onFocusOut = () => setTimeout(check, 0);

/** An agent's click is about to reach page `webContentsId`: where the focus is now is where it stays. */
export function shieldFocus(webContentsId: number, now = Date.now()): void {
  const held = shields.get(webContentsId);
  // A second click in a row keeps the person's place, not the page's.
  const back = held && held.until > now ? held.back : document.activeElement;
  shields.set(webContentsId, { until: now + SHIELD_MS, back });
  if (!watching) {
    watching = true;
    document.addEventListener("focusout", onFocusOut, true);
  }
  for (const ms of CHECKS_MS) setTimeout(check, ms);
}

/**
 * Page `view` just took the focus. When an agent's click took it, it goes
 * back to where it was and this answers true: the focus was never the
 * person's, so nothing that follows a focus (closing a panel) should happen.
 */
export function returnFocus(view: HTMLElement, webContentsId: number | null, now = Date.now()): boolean {
  if (webContentsId === null) return false;
  const shield = shields.get(webContentsId);
  if (!shield) return false;
  if (shield.until <= now) {
    shields.delete(webContentsId);
    return false;
  }
  const back = shield.back;
  if (back === view) return true;
  if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus({ preventScroll: true });
  else view.blur();
  return true;
}
