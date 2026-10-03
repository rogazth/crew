import * as api from "./api";

/** The kinds of news, each with its own banner switch and sound. */
export type NotificationKind = "done" | "needs-input" | "error" | "bell" | "connection";

export const NOTIFICATION_KINDS: { id: NotificationKind; label: string; description: string }[] = [
  { id: "needs-input", label: "Needs input", description: "A session stopped to ask a question or for approval." },
  { id: "done", label: "Turn finished", description: "A session finished its turn while you were elsewhere." },
  { id: "error", label: "Error", description: "A turn failed, or a session's CLI exited with an error." },
  { id: "bell", label: "Terminal bell", description: "A session's terminal rang its bell or sent a notification." },
  { id: "connection", label: "Connection", description: "A machine lost its connection, or came back." },
];

/** `system` is the OS's own banner sound; `custom` is the file the user picked. */
export type SoundId = "none" | "system" | "chime" | "ping" | "alert" | "tap" | "custom";

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "none", label: "None" },
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
  { id: "alert", label: "Alert" },
  { id: "tap", label: "Tap" },
  { id: "system", label: "System" },
  { id: "custom", label: "Custom" },
];

export type KindPrefs = { banner: boolean; sound: SoundId };

export type NotificationPrefs = {
  /** The master switch: off, nothing is shown or played. */
  enabled: boolean;
  kinds: Record<NotificationKind, KindPrefs>;
  /** Banners only while Crew is in the background; in front, a sound (and a toast) is enough. */
  onlyWhenUnfocused: boolean;
  /** 0 to 100, for the sounds Crew plays itself. */
  volume: number;
  /** The file the `custom` sound plays. */
  customSound: string | null;
  /** Do not disturb until this time (ms since the epoch). */
  pausedUntil: number | null;
};

export const NOTIFICATION_PREFS_KEY = "notifications:prefs";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  kinds: {
    "needs-input": { banner: true, sound: "ping" },
    done: { banner: true, sound: "chime" },
    error: { banner: true, sound: "alert" },
    bell: { banner: true, sound: "tap" },
    connection: { banner: true, sound: "none" },
  },
  onlyWhenUnfocused: true,
  volume: 70,
  customSound: null,
  pausedUntil: null,
};

const SOUND_IDS = new Set(SOUNDS.map((sound) => sound.id));

function kindPrefs(raw: unknown, fallback: KindPrefs): KindPrefs {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Partial<KindPrefs>;
  return {
    banner: typeof value.banner === "boolean" ? value.banner : fallback.banner,
    sound: typeof value.sound === "string" && SOUND_IDS.has(value.sound) ? value.sound : fallback.sound,
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
    onlyWhenUnfocused:
      typeof parsed.onlyWhenUnfocused === "boolean" ? parsed.onlyWhenUnfocused : defaults.onlyWhenUnfocused,
    volume:
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? Math.round(Math.min(100, Math.max(0, parsed.volume)))
        : defaults.volume,
    customSound: typeof parsed.customSound === "string" && parsed.customSound ? parsed.customSound : null,
    pausedUntil: typeof parsed.pausedUntil === "number" && Number.isFinite(parsed.pausedUntil) ? parsed.pausedUntil : null,
  };
}

export function isPaused(prefs: NotificationPrefs, now: number): boolean {
  return prefs.pausedUntil !== null && prefs.pausedUntil > now;
}

/**
 * Do not disturb's two lengths: an hour, or until eight in the morning. Past
 * midnight, "tomorrow" is the morning about to come, not the one after.
 */
export function pauseEnd(choice: "hour" | "tomorrow", now: Date): number {
  if (choice === "hour") return now.getTime() + 60 * 60 * 1000;
  const end = new Date(now);
  if (now.getHours() >= 5) end.setDate(end.getDate() + 1);
  end.setHours(8, 0, 0, 0);
  return end.getTime();
}

/**
 * One copy for the whole window, outside React's tree: the dispatcher reads it
 * on every notification, and Settings writes it.
 */
let prefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: NotificationPrefs) {
  prefs = next;
  for (const listener of listeners) listener();
}

export function notificationPrefs(): NotificationPrefs {
  return prefs;
}

/** Resolves once the saved prefs are in; a failed read leaves the defaults and tries again next time. */
export function loadNotificationPrefs(): Promise<void> {
  loading ??= api
    .stateGet(NOTIFICATION_PREFS_KEY)
    .then((raw) => set(parseNotificationPrefs(raw)))
    .catch(() => {
      loading = null;
    });
  return loading;
}

export function updateNotificationPrefs(next: NotificationPrefs): void {
  // A read still in flight would put back what this replaces.
  loading = Promise.resolve();
  set(next);
  void api.stateSet(NOTIFICATION_PREFS_KEY, JSON.stringify(next)).catch(() => {});
}

export function subscribeNotificationPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
