import bubbleUrl from "../assets/sounds/bubble.wav";
import popDownUrl from "../assets/sounds/pop-down.wav";
import popUpUrl from "../assets/sounds/pop-up.wav";
import thudUrl from "../assets/sounds/thud.wav";
import { beep } from "./host";
import type { SoundId } from "./notificationPrefs";

const BUNDLED: Partial<Record<SoundId, string>> = {
  "pop-up": popUpUrl,
  "pop-down": popDownUrl,
  thud: thudUrl,
  bubble: bubbleUrl,
};

/**
 * Plays `sound` at `volume` (0 to 100). `system` is the OS's beep, for when no
 * banner carries the OS sound. Resolves false when nothing could play: the
 * browser still wants a gesture first.
 */
export async function playSound(sound: SoundId, volume: number): Promise<boolean> {
  if (sound === "none" || volume <= 0) return false;
  if (sound === "system") {
    beep();
    return true;
  }
  const url = BUNDLED[sound];
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
    const audio = new Audio(popUpUrl);
    audio.volume = 0;
    void audio.play().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return stop;
}
