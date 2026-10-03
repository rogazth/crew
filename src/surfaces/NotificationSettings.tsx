import { Slider } from "@base-ui/react/slider";
import { PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, IconButton, Select, Switch, Toggle } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useNow } from "../hooks/useNow";
import { useNotificationPrefs } from "../hooks/useNotificationPrefs";
import { notificationStatus, notificationsHost, open } from "../lib/host";
import {
  isPaused,
  NOTIFICATION_KINDS,
  pauseEnd,
  SOUNDS,
  type NotificationKind,
  type NotificationPrefs,
  type SoundId,
} from "../lib/notificationPrefs";
import { dispatchNotification, type SkipReason } from "../lib/notifications";
import { forgetCustomSound, playSound } from "../lib/notificationSound";
import { isSoundFile, type BannerState } from "../lib/notify";
import { clock, dayName } from "../lib/time";

const TEST_REASONS: Partial<Record<SkipReason, string>> = {
  blocked: "macOS did not show it: notifications are off for Crew.",
  unsupported: "This system shows no notifications.",
};

export function NotificationSettings() {
  const { prefs, update } = useNotificationPrefs();
  const [status, setStatus] = useState<BannerState>("unknown");
  const [tested, setTested] = useState<string | null>(null);
  const set = <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => update({ ...prefs, [key]: value });
  const setKind = (kind: NotificationKind, change: Partial<NotificationPrefs["kinds"][NotificationKind]>) =>
    set("kinds", { ...prefs.kinds, [kind]: { ...prefs.kinds[kind], ...change } });

  const refresh = useCallback(() => {
    void notificationStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const test = () => {
    setTested(null);
    void dispatchNotification({ source: "test", title: "Crew", body: "Notifications are working." }).then((result) => {
      setTested(result.delivered ? "Sent. If no banner showed, check Focus and System Settings." : (TEST_REASONS[result.reason] ?? null));
      refresh();
    });
  };

  return (
    <>
      <SettingsSection>
        <Toggle
          label="Notifications"
          description="Banners and sounds when a session finishes, stops to ask, or fails."
          checked={prefs.enabled}
          onChange={(checked) => set("enabled", checked)}
        />
        <DoNotDisturb prefs={prefs} onChange={(until) => set("pausedUntil", until)} />
        {status === "blocked" && <Blocked />}
        <SettingsRow label="Test" description={tested ?? "Sends a banner with the Needs input sound."}>
          <Button className="h-7 text-[12px]" onClick={test}>
            Send test
          </Button>
        </SettingsRow>
      </SettingsSection>

      <div className={`flex flex-col gap-8 transition-opacity ${prefs.enabled ? "" : "opacity-50"}`}>
        <SettingsSection title="Events">
          {NOTIFICATION_KINDS.map((kind) => {
            const own = prefs.kinds[kind.id];
            return (
              <SettingsRow key={kind.id} label={kind.label} description={kind.description}>
                <SoundPicker
                  label={`${kind.label} sound`}
                  value={own.sound}
                  prefs={prefs}
                  onChange={(sound) => setKind(kind.id, { sound })}
                />
                <span className="ml-2 text-[12px] text-text-muted" aria-hidden>
                  Banner
                </span>
                <Switch
                  label={`${kind.label} banner`}
                  checked={own.banner}
                  onChange={(banner) => setKind(kind.id, { banner })}
                />
              </SettingsRow>
            );
          })}
        </SettingsSection>

        <SettingsSection title="Sound">
          <SettingsRow label="Volume" description="For Crew's own sounds. System follows the Mac's alert volume.">
            <Volume value={prefs.volume} onCommit={(volume) => set("volume", volume)} preview={prefs.kinds["needs-input"].sound} prefs={prefs} />
          </SettingsRow>
          <CustomSound path={prefs.customSound} onChange={(path) => set("customSound", path)} volume={prefs.volume} />
        </SettingsSection>

        <SettingsSection title="While Crew is in front">
          <Toggle
            label="Banners only when Crew is in the background"
            description={
              prefs.onlyWhenUnfocused
                ? "With Crew in front, news of another session shows in the window instead."
                : "Banners show for any session but the one on screen, Crew in front or not."
            }
            checked={prefs.onlyWhenUnfocused}
            onChange={(checked) => set("onlyWhenUnfocused", checked)}
          />
          <Toggle
            label="Show toasts"
            description="A note in the corner for news of another session, with a button to open it."
            checked={prefs.toasts}
            onChange={(checked) => set("toasts", checked)}
          />
        </SettingsSection>

        <SettingsSection title="Dock">
          <Toggle
            label="Badge"
            description="Counts the sessions that finished or stopped to ask while Crew was in the background. Coming back to Crew clears it."
            checked={prefs.badge}
            onChange={(checked) => set("badge", checked)}
          />
          <Toggle
            label="Bounce"
            description="The icon bounces once when that count goes up."
            checked={prefs.bounce}
            onChange={(checked) => set("bounce", checked)}
          />
        </SettingsSection>
      </div>
    </>
  );
}

function DoNotDisturb({ prefs, onChange }: { prefs: NotificationPrefs; onChange: (until: number | null) => void }) {
  const now = useNow(30_000);
  const paused = isPaused(prefs, now);
  const until = prefs.pausedUntil ?? 0;
  const when = dayName(until, now) === "Today" ? clock(until) : `${dayName(until, now).toLowerCase()} at ${clock(until)}`;
  return (
    <SettingsRow
      label="Do not disturb"
      description={paused ? `Paused until ${when}.` : "No banners or sounds for a while."}
    >
      {paused ? (
        <Button className="h-7 text-[12px]" onClick={() => onChange(null)}>
          Resume
        </Button>
      ) : (
        <>
          <Button variant="ghost" className="h-7 text-[12px]" onClick={() => onChange(pauseEnd("hour", new Date()))}>
            For 1 hour
          </Button>
          <Button variant="ghost" className="h-7 text-[12px]" onClick={() => onChange(pauseEnd("tomorrow", new Date()))}>
            Until tomorrow
          </Button>
        </>
      )}
    </SettingsRow>
  );
}

/** macOS swallowed a banner: Crew is off in System Settings › Notifications. */
function Blocked() {
  const host = notificationsHost();
  return (
    <SettingsRow
      label="Banners are blocked"
      description={
        host
          ? "macOS has notifications turned off for Crew. Sounds still play."
          : "This browser blocks notifications for Crew. Sounds still play."
      }
    >
      {host && (
        <Button className="h-7 text-[12px]" onClick={() => void host.openSettings()}>
          Open System Settings
        </Button>
      )}
    </SettingsRow>
  );
}

function SoundPicker({
  label,
  value,
  prefs,
  onChange,
}: {
  label: string;
  value: SoundId;
  prefs: NotificationPrefs;
  onChange: (sound: SoundId) => void;
}) {
  const options = SOUNDS.filter((sound) => sound.id !== "custom" || prefs.customSound || value === "custom");
  const silent = value === "none" || (value === "custom" && !prefs.customSound);
  return (
    <>
      <Select
        label={label}
        className="w-28"
        value={value}
        onChange={onChange}
        options={options.map((sound) => ({ value: sound.id, label: sound.label }))}
      />
      <IconButton
        icon={PlayIcon}
        label={`Preview ${label.toLowerCase()}`}
        className="size-7"
        disabled={silent}
        onClick={() => void playSound(value, Math.max(prefs.volume, 1), prefs.customSound)}
      />
    </>
  );
}

/** Drags freely; the value is saved, and heard, where it is let go. */
function Volume({
  value,
  onCommit,
  preview,
  prefs,
}: {
  value: number;
  onCommit: (value: number) => void;
  preview: SoundId;
  prefs: NotificationPrefs;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  return (
    <div className="flex items-center gap-3">
      <Slider.Root
        value={shown}
        min={0}
        max={100}
        step={5}
        onValueChange={(next) => setDragging(next)}
        onValueCommitted={(next) => {
          setDragging(null);
          onCommit(next);
          if (preview !== "system") void playSound(preview, next, prefs.customSound);
        }}
        className="w-40"
      >
        <Slider.Control className="flex h-5 w-full touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-selected">
            <Slider.Indicator className="rounded-full bg-accent" />
            <Slider.Thumb
              aria-label="Volume"
              className="size-3.5 rounded-full bg-canvas shadow-sm ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="w-9 text-right text-[12px] text-text-muted tabular-nums">{shown}%</span>
    </div>
  );
}

function CustomSound({
  path,
  onChange,
  volume,
}: {
  path: string | null;
  onChange: (path: string | null) => void;
  volume: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const choose = () => {
    void open({}).then((picked) => {
      if (typeof picked !== "string") return;
      if (!isSoundFile(picked)) {
        setError("That is not an audio file Crew can play: pick a WAV, MP3, M4A, AIFF, OGG or FLAC.");
        return;
      }
      setError(null);
      if (path) forgetCustomSound(path);
      forgetCustomSound(picked);
      onChange(picked);
    });
  };
  const name = path?.split("/").pop();
  return (
    <SettingsRow
      label="Custom sound"
      description={error ?? (name ? `${name}, for any event set to Custom.` : "An audio file of your own, for any event set to Custom.")}
    >
      {path && (
        <>
          <IconButton icon={PlayIcon} label="Preview custom sound" className="size-7" onClick={() => void playSound("custom", Math.max(volume, 1), path)} />
          <IconButton
            icon={XIcon}
            label="Remove custom sound"
            className="size-7"
            onClick={() => {
              forgetCustomSound(path);
              onChange(null);
            }}
          />
        </>
      )}
      <Button className="h-7 text-[12px]" onClick={choose}>
        Choose…
      </Button>
    </SettingsRow>
  );
}
