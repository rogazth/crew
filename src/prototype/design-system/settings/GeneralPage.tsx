// PROTOTYPE — throwaway. General, to the gallery's direction: cards of rows.
// Bypass permissions lives on Providers, beside the access it overrides. Tabs and retention read the
// real state where the daemon answers; the rest is local.
import { useEffect, useState } from "react";
import { Button, Select } from "../../../chrome/kit";
import * as api from "../../../lib/api";
import { RETENTION_CHOICES, RETENTION_KEY, parseRetention, type Retention } from "../../../lib/retention";
import { Chip, ConfirmDialog, CopyButton, Group, Row, SettingsPage, ToggleRow, toast, wait, type ConfirmAsk } from "./ui";

let local = { badge: true, login: false, reopen: true, cli: false };

export function GeneralPage() {
  const [retention, setRetention] = useState<Retention>("never");
  const [prefs, setPrefs] = useState(local);
  const [cliBusy, setCliBusy] = useState(false);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const set = (change: Partial<typeof prefs>) => {
    local = { ...prefs, ...change };
    setPrefs(local);
  };

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

  const chooseRetention = (next: Retention) => {
    if (next === retention) return;
    const save = () => {
      setRetention(next);
      if (next === "never") void api.stateDelete(RETENTION_KEY).catch(() => {});
      else
        void api
          .stateSet(RETENTION_KEY, next)
          .then(() => api.expireSessions(Number(next)))
          .catch(() => {});
    };
    if (next === "never") return save();
    setAsk({
      title: "Delete old sessions?",
      description: `Sessions idle for ${next}+ days will be deleted.`,
      action: "Delete",
      onConfirm: save,
    });
  };

  const toggleCli = async () => {
    setCliBusy(true);
    await wait(900);
    setCliBusy(false);
    set({ cli: !prefs.cli });
    toast(prefs.cli ? "crew uninstalled" : "crew installed");
  };

  return (
    <SettingsPage title="General">
      <Group title="Sessions">
        <Row
          id="retention"
          label="Delete inactive sessions"
          description="Active and unread sessions are kept."
        >
          <Select<Retention>
            label="Delete inactive sessions"
            className="w-40"
            value={retention}
            onChange={chooseRetention}
            options={RETENTION_CHOICES}
          />
        </Row>
        <ToggleRow
          id="notify-needs-you"
          label="Dock badge"
          description="Count of sessions waiting on you."
          checked={prefs.badge}
          onChange={(badge) => set({ badge })}
        />
      </Group>

      <Group title="Startup">
        <ToggleRow
          id="login"
          label="Open at login"
          description="Keeps routines on schedule."
          checked={prefs.login}
          onChange={(login) => set({ login })}
        />
        <ToggleRow
          label="Reopen where you left off"
          description="Restore your last workspace and tabs."
          checked={prefs.reopen}
          onChange={(reopen) => set({ reopen })}
        />
      </Group>

      <Group title="Command line">
        <Row
          id="crew-command"
          label={
            <span className="flex items-center gap-2">
              <span className="font-mono text-[12px]">crew</span> command
              {prefs.cli && <Chip tone="success">Installed</Chip>}
            </span>
          }
          description={
            prefs.cli ? (
              <span className="flex items-center gap-1">
                Linked at <span className="font-mono">~/.local/bin/crew</span>
                <CopyButton text="~/.local/bin/crew" label="Copy path" className="size-5" />
              </span>
            ) : (
              "Use Crew from your terminal."
            )
          }
        >
          <Button variant={prefs.cli ? "ghost" : "secondary"} loading={cliBusy} onClick={() => void toggleCli()}>
            {prefs.cli ? "Uninstall" : "Install"}
          </Button>
        </Row>
      </Group>

      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </SettingsPage>
  );
}
