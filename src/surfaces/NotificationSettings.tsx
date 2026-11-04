import { Slider } from "@base-ui/react/slider";
import { BellOffIcon } from "lucide-react";
import { useState } from "react";
import { Button, Select, Switch, Toggle } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useNow } from "../hooks/useNow";
import { useNotificationPrefs } from "../hooks/useNotificationPrefs";
import { notificationsHost } from "../lib/host";
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
import { playSound } from "../lib/notificationSound";
import { READS, refresh, useRead } from "../lib/settingsReads";
import { clock, dayName } from "../lib/time";
import { Callout, toast } from "./settings/ui";

const TEST_REASONS: Partial<Record<SkipReason, string>> = {
  blocked: "Notifications are blocked.",
  unsupported: "This system shows no notifications.",
};

const rereadBanners = () => void refresh(READS.banners);

export function NotificationSettings() {
  const { prefs, update } = useNotificationPrefs();
  const status = useRead(READS.banners) ?? "unknown";
  const set = <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => update({ ...prefs, [key]: value });
  const setKind = (kind: NotificationKind, change: Partial<NotificationPrefs["kinds"][NotificationKind]>) =>
    set("kinds", { ...prefs.kinds, [kind]: { ...prefs.kinds[kind], ...change } });

  const test = () => {
    void dispatchNotification({ source: "test", title: "Crew", body: "Notifications are working." }).then((result) => {
      const failed = result.delivered ? undefined : TEST_REASONS[result.reason];
      if (result.delivered) toast("Sent. No banner? Check Focus and system settings.");
      else if (failed) toast(failed, "danger");
      rereadBanners();
    });
  };

  return (
    <>
      {status === "blocked" && <Blocked />}
      <SettingsSection>
        <Toggle
          label="Notifications"
          description="Turn all app notifications on or off."
          checked={prefs.enabled}
          onChange={(checked) => set("enabled", checked)}
        />
        <Toggle
          label="Show toasts"
          description="Alerts inside the app, for other sessions."
          checked={prefs.toasts}
          onChange={(checked) => set("toasts", checked)}
        />
        <DoNotDisturb prefs={prefs} onChange={(until) => set("pausedUntil", until)} />
        <SettingsRow label="Test" description="Send a sample notification.">
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
                  volume={prefs.volume}
                  disabled={!own.enabled}
                  onChange={(sound) => setKind(kind.id, { sound })}
                />
                <div className="ml-4 flex">
                  <Switch
                    label={kind.label}
                    checked={own.enabled}
                    onChange={(enabled) => setKind(kind.id, { enabled })}
                  />
                </div>
              </SettingsRow>
            );
          })}
        </SettingsSection>

        <SettingsSection title="Sound">
          <SettingsRow id="notif-sound" label="Volume" description="Doesn't affect the System sound.">
            <Volume value={prefs.volume} onCommit={(volume) => set("volume", volume)} preview={prefs.kinds["needs-input"].sound} />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Dock">
          <div data-setting="notify-needs-you">
            <Toggle
              label="Badge"
              description="Count waiting sessions on the Dock icon."
              checked={prefs.badge}
              onChange={(checked) => set("badge", checked)}
            />
          </div>
          <Toggle
            label="Bounce"
            description="Bounce the Dock icon when a session needs you."
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
      description={paused ? `Paused until ${when}.` : "Pause notifications for a while."}
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
    <Callout
      tone="warning"
      icon={BellOffIcon}
      title="Allow notifications"
      description={host ? undefined : "In your browser's site settings."}
      action={
        host && (
          <Button className="h-7 text-[12px]" onClick={() => void host.openSettings()}>
            Open system settings
          </Button>
        )
      }
    />
  );
}

function SoundPicker({
  label,
  value,
  volume,
  disabled,
  onChange,
}: {
  label: string;
  value: SoundId;
  volume: number;
  disabled: boolean;
  onChange: (sound: SoundId) => void;
}) {
  return (
    <Select
      label={label}
      className="w-28"
      value={value}
      disabled={disabled}
      onChange={(sound) => {
        onChange(sound);
        void playSound(sound, Math.max(volume, 1));
      }}
      options={SOUNDS.map((sound) => ({ value: sound.id, label: sound.label }))}
    />
  );
}

/** Drags freely; the value is saved, and heard, where it is let go. */
function Volume({
  value,
  onCommit,
  preview,
}: {
  value: number;
  onCommit: (value: number) => void;
  preview: SoundId;
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
          if (preview !== "system") void playSound(preview, next);
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
