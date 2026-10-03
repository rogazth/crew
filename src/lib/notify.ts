/**
 * What crosses between the window and main for a desktop banner. Main shows
 * it; the window decides whether it should, and where a click on it leads.
 */
export const NOTIFY_CHANNELS = {
  show: "notify",
  click: "notify:click",
} as const;

/** The session a banner is about: clicking it brings the window up on that session. */
export type NotificationTarget = { workspaceId: string; sessionId: string };

export type Banner = {
  title: string;
  body: string;
  target?: NotificationTarget | null;
  /** The window plays its own sound, so the OS stays quiet. */
  silent?: boolean;
};

/**
 * Whether macOS took it. `blocked` is the one definite answer: notifications
 * are off for Crew in System Settings. A banner that never says either way
 * counts as shown.
 */
export type BannerResult = "shown" | "blocked" | "unsupported";

/** A banner's body is a glance, not the transcript. */
export const BODY_LIMIT = 200;
