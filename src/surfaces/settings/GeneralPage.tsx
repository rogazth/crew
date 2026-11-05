// General: the first page of Settings. One card of rows on real state (retention
// is a setting every machine holds, lib/settingsEngine; Open at login lives in the
// app's login item; Open links in Crew is the browser's pref, about where a chat's
// links go), then how the app looks, terminals included.
import { useState } from "react";
import { Select } from "../../chrome/kit";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import * as api from "../../lib/api";
import { BROWSER_CLICK } from "../../lib/external";
import { loginItemHost } from "../../lib/host";
import { RETENTION_CHOICES, retention as retentionSetting, type Retention } from "../../lib/retention";
import { setSetting, useSetting, useSettingsSync } from "../../lib/settingsEngine/store";
import { syncLine } from "../../lib/settingsEngine/syncLine";
import { READS, keep, useRead } from "../../lib/settingsReads";
import { TerminalSettings } from "../TerminalSettings";
import { AppearanceSections } from "./AppearanceSections";
import { ConfirmDialog, Group, Row, SettingsPage, ToggleRow, toast, type ConfirmAsk } from "./ui";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const saveLogin = (enabled: boolean) =>
  loginItemHost()
    ?.set(enabled)
    .then((state) => keep(READS.login, state), (error) => toast(`Could not change it: ${reason(error)}`, "danger"));

const saveRetention = async (next: Retention) => {
  try {
    await setSetting(retentionSetting, next);
    if (next !== "never") await api.expireSessions(Number(next));
  } catch (error) {
    toast(`Could not save: ${reason(error)}`, "danger");
  }
};

export function GeneralPage() {
  // Read ahead as Settings opened (lib/settingsReads), so the page paints with what is saved.
  const retention = useSetting(retentionSetting);
  const sync = syncLine(useSettingsSync());
  const login = useRead(READS.login) ?? null;
  const { prefs, update } = useBrowserPrefs();
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);

  const chooseRetention = async (next: Retention) => {
    if (next === retention) return;
    if (next === "never") return saveRetention(next);
    const days = Number(next);
    const stale = await api.staleSessions(days).catch(() => 0);
    if (stale === 0) return saveRetention(next);
    const sessions = stale === 1 ? "1 session" : `${stale} sessions`;
    setAsk({
      title: `Delete ${sessions}?`,
      description: `Deletes ${sessions} idle over ${days} days, and others as they age.`,
      action: "Delete",
      onConfirm: () => void saveRetention(next),
    });
  };

  return (
    <SettingsPage title="General">
      <div className="flex flex-col gap-2">
        <Group>
          {login?.supported && (
            <ToggleRow
              id="login"
              label="Open at login"
              description="Keeps routines on schedule."
              checked={login.enabled}
              onChange={(next) => void saveLogin(next)}
            />
          )}
          <ToggleRow
            id="links-in-crew"
            label="Open links in Crew"
            description="Chat and terminal links open here."
            title={`${BROWSER_CLICK}-click a link to open it in your browser.`}
            checked={prefs.openLinksInCrew}
            onChange={(checked) => update({ ...prefs, openLinksInCrew: checked })}
          />
          <Row id="retention" label="Delete inactive sessions">
            <Select<Retention>
              label="Delete inactive sessions"
              className="w-40"
              value={retention}
              onChange={(next) => void chooseRetention(next)}
              options={RETENTION_CHOICES}
            />
          </Row>
        </Group>
        {sync && <p className="px-2.5 text-[12px] text-text-muted">{sync}</p>}
      </div>

      <AppearanceSections />
      <TerminalSettings />

      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </SettingsPage>
  );
}
