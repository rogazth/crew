import { useEffect, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Select, Toggle } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import * as api from "../lib/api";
import { BYPASS_KEY } from "../lib/permissions";
import { RETENTION_CHOICES, RETENTION_KEY, parseRetention, type Retention } from "../lib/retention";

/**
 * How long an untouched session is kept. Picking a shorter span deletes what is
 * already past it, so that asks first; the daemon keeps it up from then on.
 */
export function SessionSettings({ onConfirm }: { onConfirm: (confirm: Confirm) => void }) {
  const [retention, setRetention] = useState<Retention>("never");
  const [bypass, setBypass] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(RETENTION_KEY)
      .then((raw) => !cancelled && setRetention(parseRetention(raw)))
      .catch(() => {});
    api
      .stateGet(BYPASS_KEY)
      .then((raw) => !cancelled && setBypass(raw?.trim() === "on"))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: Retention) => {
    if (next === "never") await api.stateDelete(RETENTION_KEY);
    else await api.stateSet(RETENTION_KEY, next);
    setRetention(next);
  };

  const saveBypass = async (next: boolean) => {
    if (next) await api.stateSet(BYPASS_KEY, "on");
    else await api.stateDelete(BYPASS_KEY);
    setBypass(next);
  };

  const chooseBypass = (next: boolean) => {
    if (!next) return void saveBypass(false);
    onConfirm({
      title: "Bypass permissions for every session?",
      description:
        "All agents will edit files and run commands without asking, from their next turn.",
      action: "Bypass",
      onConfirm: () => saveBypass(true),
    });
  };

  const choose = async (next: Retention) => {
    if (next === retention) return;
    if (next === "never") return save(next);
    const days = Number(next);
    const stale = await api.staleSessions(days).catch(() => 0);
    if (stale === 0) return save(next);
    const sessions = stale === 1 ? "1 session" : `${stale} sessions`;
    onConfirm({
      title: `Delete ${sessions}?`,
      description: `Deletes ${sessions} idle over ${days} days, and others as they age. Provider history is kept.`,
      action: "Delete",
      onConfirm: async () => {
        await save(next);
        await api.expireSessions(days);
      },
    });
  };

  return (
    <SettingsSection title="Sessions">
      <SettingsRow
        label="Delete inactive sessions"
        description="Working, unread, open and scheduled sessions are kept."
      >
        <Select
          label="Delete inactive sessions"
          className="w-40"
          value={retention}
          onChange={(next) => void choose(next)}
          options={RETENTION_CHOICES}
        />
      </SettingsRow>
      <Toggle
        label="Bypass permissions"
        description="All sessions run tools without asking."
        checked={bypass}
        onChange={chooseBypass}
      />
    </SettingsSection>
  );
}
