import { IS_MAC } from "./hotkey";

/**
 * Where the chrome leaves room for the toggle: past the traffic lights on
 * macOS, and a gutter elsewhere. The sidebar header and the tab strip both
 * reserve exactly this, so nothing under the toggle shifts when it is pressed.
 */
export const TOGGLE_RESERVE = IS_MAC ? "w-[112px]" : "w-11";
