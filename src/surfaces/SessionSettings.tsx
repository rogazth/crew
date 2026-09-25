import { useEffect, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Select } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import * as api from "../lib/api";
import { RETENTION_CHOICES, RETENTION_KEY, parseRetention, type Retention } from "../lib/retention";

/**
 * How long an untouched session is kept. Picking a shorter span deletes what is
 * already past it, so that asks first; the daemon keeps it up from then on.
 */
export function SessionSettings({ onConfirm }: { onConfirm: (confirm: Confirm) => void }) {
  const [retention, setRetention] = useState<Retention>("never");

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(RETENTION_KEY)
      .then((raw) => !cancelled && setRetention(parseRetention(raw)))
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

  const choose = async (next: Retention) => {
    if (next === retention) return;
    if (next === "never") return save(next);
    const days = Number(next);
    const stale = await api.staleSessions(days).catch(() => 0);
    if (stale === 0) return save(next);
    const sessions = stale === 1 ? "1 session" : `${stale} sessions`;
    onConfirm({
      title: `Delete ${sessions}?`,
      description: `${sessions} untouched for over ${days} days will be deleted with their messages, and later ones as they reach that age. Each provider keeps its own history of the conversation.`,
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
        description="Sessions untouched this long are deleted. Ones that are working, unread, open in a tab or running a routine are kept."
      >
        <Select
          label="Delete inactive sessions"
          className="w-40"
          value={retention}
          onChange={(next) => void choose(next)}
          options={RETENTION_CHOICES}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
