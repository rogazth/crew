import { defineSetting } from "./settingsEngine/define";
import { peekSetting, readSetting, saveSetting, watchSetting } from "./settingsEngine/store";

/** The kinds of news, each with its own switch and sound. */
export type NotificationKind =
  | "done"
  | "needs-input"
  | "approval"
  | "error"
  | "process"
  | "bell"
  | "connection";

export const NOTIFICATION_KINDS: { id: NotificationKind; label: string; description: string }[] = [
  { id: "needs-input", label: "Needs input", description: "A session has a question." },
  { id: "approval", label: "Needs approval", description: "A session wants permission to act." },
  { id: "done", label: "Turn finished", description: "A session finished its turn." },
  { id: "error", label: "Error", description: "A session's turn failed." },
  { id: "process", label: "Command crashed", description: "A process failed or kept crashing." },
  { id: "bell", label: "Terminal bell", description: "A terminal asked for attention." },
  { id: "connection", label: "Connection", description: "A machine connected or disconnected." },
];

/** `system` is the OS's own banner sound. */
export type SoundId = "none" | "system" | "pop-up" | "pop-down" | "thud" | "bubble";

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "none", label: "None" },
  { id: "pop-up", label: "Pop up" },
  { id: "pop-down", label: "Pop down" },
  { id: "thud", label: "Thud" },
  { id: "bubble", label: "Bubble" },
  { id: "system", label: "System" },
];

/** Off, the kind is neither shown nor heard. */
export type KindPrefs = { enabled: boolean; sound: SoundId };

export type NotificationPrefs = {
  /** The master switch: off, nothing is shown or played. */
  enabled: boolean;
  kinds: Record<NotificationKind, KindPrefs>;
  /** In front, news of another session shows in the window, with a way to open it. */
  toasts: boolean;
  /** The Dock icon counts sessions waiting on the user. */
  badge: boolean;
  /** The Dock icon bounces once when that count goes up with Crew in the background. */
  bounce: boolean;
  /** 0 to 100, for the sounds Crew plays itself. */
  volume: number;
};

export const NOTIFICATION_PREFS_KEY = "notifications:prefs";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  kinds: {
    "needs-input": { enabled: true, sound: "pop-up" },
    approval: { enabled: true, sound: "pop-up" },
    done: { enabled: true, sound: "pop-down" },
    error: { enabled: true, sound: "thud" },
    process: { enabled: true, sound: "thud" },
    bell: { enabled: true, sound: "bubble" },
    connection: { enabled: true, sound: "none" },
  },
  toasts: true,
  badge: true,
  bounce: false,
  volume: 70,
};

const SOUND_IDS = new Set(SOUNDS.map((sound) => sound.id));

/** The sounds Crew shipped before the pops, each saved choice kept as the pop that took its place. */
const RENAMED: Record<string, SoundId> = { ping: "pop-up", chime: "pop-down", alert: "thud", tap: "bubble" };

function kindPrefs(raw: unknown, fallback: KindPrefs): KindPrefs {
  if (!raw || typeof raw !== "object") return fallback;
  // `banner` is what the switch was saved as when it only ruled the banner.
  const value = raw as Partial<KindPrefs> & { banner?: unknown };
  const enabled = value.enabled ?? value.banner;
  return {
    enabled: typeof enabled === "boolean" ? enabled : fallback.enabled,
    sound:
      typeof value.sound !== "string"
        ? fallback.sound
        : SOUND_IDS.has(value.sound)
          ? value.sound
          : (RENAMED[value.sound] ?? fallback.sound),
  };
}

/** Whatever was saved, made whole: a field it lacks, or a kind added since, takes its default. */
export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  if (!raw) return DEFAULT_NOTIFICATION_PREFS;
  let parsed: Partial<NotificationPrefs>;
  try {
    parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_NOTIFICATION_PREFS;
  const defaults = DEFAULT_NOTIFICATION_PREFS;
  const kinds = { ...defaults.kinds };
  for (const kind of NOTIFICATION_KINDS) kinds[kind.id] = kindPrefs(parsed.kinds?.[kind.id], defaults.kinds[kind.id]);
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    kinds,
    toasts: typeof parsed.toasts === "boolean" ? parsed.toasts : defaults.toasts,
    badge: typeof parsed.badge === "boolean" ? parsed.badge : defaults.badge,
    bounce: typeof parsed.bounce === "boolean" ? parsed.bounce : defaults.bounce,
    volume:
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? Math.round(Math.min(100, Math.max(0, parsed.volume)))
        : defaults.volume,
  };
}

export const notificationPrefsSetting = defineSetting<NotificationPrefs>({
  key: NOTIFICATION_PREFS_KEY,
  scope: "device",
  fallback: DEFAULT_NOTIFICATION_PREFS,
  parse: parseNotificationPrefs,
  format: JSON.stringify,
});

/** The dispatcher reads it on every notification, outside React's tree; Settings writes it. */
export function notificationPrefs(): NotificationPrefs {
  return peekSetting(notificationPrefsSetting);
}

/** Resolves once the saved prefs are in; a failed read leaves the defaults and tries again next time. */
export async function loadNotificationPrefs(): Promise<void> {
  await readSetting(notificationPrefsSetting).catch(() => {});
}

export function updateNotificationPrefs(next: NotificationPrefs): void {
  saveSetting(notificationPrefsSetting, next);
}

export function subscribeNotificationPrefs(listener: () => void): () => void {
  return watchSetting(notificationPrefsSetting, listener);
}
