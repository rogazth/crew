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
        "Every agent, on every provider, will edit files and run commands without asking, whatever its own setting says. It applies from each session's next turn.",
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
      <Toggle
        label="Bypass permissions"
        description="Every session runs tools without asking, on every provider, overriding each agent's own autonomy."
        checked={bypass}
        onChange={chooseBypass}
      />
    </SettingsSection>
  );
}
