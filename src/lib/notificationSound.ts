import alertUrl from "../assets/sounds/alert.wav";
import chimeUrl from "../assets/sounds/chime.wav";
import pingUrl from "../assets/sounds/ping.wav";
import tapUrl from "../assets/sounds/tap.wav";
import { beep, readSound } from "./host";
import type { SoundId } from "./notificationPrefs";

const BUNDLED: Partial<Record<SoundId, string>> = { chime: chimeUrl, ping: pingUrl, alert: alertUrl, tap: tapUrl };

/** The custom file, read once per path and kept as a blob URL. */
const custom = new Map<string, Promise<string | null>>();

function customUrl(path: string): Promise<string | null> {
  let url = custom.get(path);
  if (!url) {
    url = readSound(path)
      .then((bytes) => (bytes ? URL.createObjectURL(new Blob([new Uint8Array(bytes)])) : null))
      .catch(() => null);
    custom.set(path, url);
    // A file that could not be read is tried again next time; it may be back.
    void url.then((found) => found === null && custom.delete(path));
  }
  return url;
}

/** Forgets a custom file read earlier: the user picked another, or the same path changed. */
export function forgetCustomSound(path: string): void {
  const url = custom.get(path);
  custom.delete(path);
  void url?.then((found) => found && URL.revokeObjectURL(found));
}

/**
 * Plays `sound` at `volume` (0 to 100). `system` is the OS's beep, for when no
 * banner carries the OS sound. Resolves false when nothing could play: the
 * custom file is gone, or the browser still wants a gesture first.
 */
export async function playSound(sound: SoundId, volume: number, customPath: string | null): Promise<boolean> {
  if (sound === "none" || volume <= 0) return false;
  if (sound === "system") {
    beep();
    return true;
  }
  const url = sound === "custom" ? customPath && (await customUrl(customPath)) : BUNDLED[sound];
  if (!url) return false;
  const audio = new Audio(url);
  audio.volume = Math.min(1, volume / 100);
  try {
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/**
 * A browser plays audio only after the page was clicked or typed in. The first
 * gesture plays a silent clip so a sound later, with nobody touching the
 * window, is allowed. Electron needs no gesture; this costs it nothing.
 */
export function unlockNotificationAudio(): () => void {
  const stop = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  const unlock = () => {
    stop();
    const audio = new Audio(tapUrl);
    audio.volume = 0;
    void audio.play().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return stop;
}
