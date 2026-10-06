/**
 * What crosses between the window and main for a desktop banner. Main shows
 * it; the window decides whether it should, and where a click on it leads.
 */
export const NOTIFY_CHANNELS = {
  show: "notify",
  click: "notify:click",
  beep: "notify:beep",
  sound: "notify:sound",
  status: "notify:status",
  settings: "notify:settings",
  badge: "notify:badge",
  dismiss: "notify:dismiss",
} as const;

/** The Dock's count of sessions waiting on the user; `bounce` asks for one informational bounce. */
export type DockBadge = { count: number; bounce: boolean };

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

/** What the last banner said, for Settings; `unknown` until one is shown. */
export type BannerState = BannerResult | "unknown";

/** The largest custom sound main reads: a notification is a second or two, not a song. */
export const SOUND_LIMIT = 5 * 1024 * 1024;

/** Audio files the custom sound may be: what Chromium plays. */
export const SOUND_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "aiff", "aif", "ogg", "oga", "flac", "caf"];

export function isSoundFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SOUND_EXTENSIONS.includes(ext);
}

/** A banner's body is a glance, not the transcript. */
export const BODY_LIMIT = 200;
