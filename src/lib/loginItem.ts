/**
 * Whether Crew opens when the user signs in to their Mac, as main and the
 * General settings agree on it. Imported by both sides, so it stays free of
 * DOM and Electron.
 */

export const LOGIN_ITEM_CHANNELS = {
  get: "login-item:get",
  set: "login-item:set",
} as const;

/** `supported` is false where the OS has no login items for this build: a dev build, or Linux. */
export type LoginItemState = { supported: boolean; enabled: boolean };
