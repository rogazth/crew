// General: cards of rows, all on real state. Retention and bypass live in the
// daemon's state, Open at login in the app's login item, Reopen in a preference
// the workspace list reads at launch, and the `crew` command in the app's link.
import { useEffect, useState } from "react";
import { Button, Select } from "../../chrome/kit";
import * as api from "../../lib/api";
import { describeCli, type CliResult, type CliStatus } from "../../lib/cli";
import { cliHost, homeDir, loginItemHost } from "../../lib/host";
import type { LoginItemState } from "../../lib/loginItem";
import { BYPASS_KEY } from "../../lib/permissions";
import { RETENTION_CHOICES, RETENTION_KEY, parseRetention, type Retention } from "../../lib/retention";
import { REOPEN_KEY, parseReopen } from "../../lib/startup";
import { Chip, ConfirmDialog, CopyButton, Group, Row, SettingsPage, ToggleRow, toast, type ConfirmAsk } from "./ui";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function GeneralPage() {
  const [retention, setRetention] = useState<Retention>("never");
  const [bypass, setBypass] = useState(false);
  const [reopen, setReopen] = useState(true);
  const [login, setLogin] = useState<LoginItemState | null>(null);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (key: string, apply: (raw: string | null) => void) =>
      api
        .stateGet(key)
        .then((raw) => !cancelled && apply(raw))
        .catch(() => {});
    read(RETENTION_KEY, (raw) => setRetention(parseRetention(raw)));
    read(BYPASS_KEY, (raw) => setBypass(raw?.trim() === "on"));
    read(REOPEN_KEY, (raw) => setReopen(parseReopen(raw)));
    loginItemHost()
      ?.get()
      .then((state) => !cancelled && setLogin(state))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The shown value moves only once the daemon has kept it.
  const keep = async (key: string, value: string | null) => {
    if (value === null) await api.stateDelete(key);
    else await api.stateSet(key, value);
  };

  const saveRetention = async (next: Retention) => {
    try {
      await keep(RETENTION_KEY, next === "never" ? null : next);
      setRetention(next);
      if (next !== "never") await api.expireSessions(Number(next));
    } catch (error) {
      toast(`Could not save: ${reason(error)}`, "danger");
    }
  };

  const chooseRetention = async (next: Retention) => {
    if (next === retention) return;
    if (next === "never") return saveRetention(next);
    const days = Number(next);
    const stale = await api.staleSessions(days).catch(() => 0);
    if (stale === 0) return saveRetention(next);
    const sessions = stale === 1 ? "1 session" : `${stale} sessions`;
    setAsk({
      title: `Delete ${sessions}?`,
      description: `Deletes ${sessions} idle over ${days} days, and others as they age. Provider history is kept.`,
      action: "Delete",
      onConfirm: () => void saveRetention(next),
    });
  };

  const saveBypass = (next: boolean) =>
    keep(BYPASS_KEY, next ? "on" : null).then(
      () => setBypass(next),
      (error) => toast(`Could not save: ${reason(error)}`, "danger"),
    );

  const saveReopen = (next: boolean) =>
    keep(REOPEN_KEY, next ? null : "off").then(
      () => setReopen(next),
      (error) => toast(`Could not save: ${reason(error)}`, "danger"),
    );

  const saveLogin = (enabled: boolean) =>
    loginItemHost()
      ?.set(enabled)
      .then(setLogin, (error) => toast(`Could not change it: ${reason(error)}`, "danger"));

  return (
    <SettingsPage title="General">
      <Group title="Sessions">
        <Row
          id="retention"
          label="Delete inactive sessions"
          description="Working, unread, open and scheduled sessions are kept."
        >
          <Select<Retention>
            label="Delete inactive sessions"
            className="w-40"
            value={retention}
            onChange={(next) => void chooseRetention(next)}
            options={RETENTION_CHOICES}
          />
        </Row>
        <ToggleRow
          id="bypass"
          label="Bypass permissions"
          description="All sessions run tools without asking."
          checked={bypass}
          onChange={(next) =>
            next
              ? setAsk({
                  title: "Bypass permissions for every session?",
                  description: "All agents will edit files and run commands without asking, from their next turn.",
                  action: "Bypass",
                  onConfirm: () => void saveBypass(true),
                })
              : void saveBypass(false)
          }
        />
      </Group>

      <Group title="Startup">
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
          id="reopen"
          label="Reopen where you left off"
          description="Restore your last workspace and tabs. Off starts at Home."
          checked={reopen}
          onChange={(next) => void saveReopen(next)}
        />
      </Group>

      <CommandLine />

      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </SettingsPage>
  );
}

/** The `crew` command for the user's own terminal. Only in the app: a browser has no PATH to link into. */
function CommandLine() {
  const host = cliHost();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [home, setHome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    host
      ?.status()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => {});
    void homeDir().then((dir) => !cancelled && setHome(dir));
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host || !status) return null;
  const act = (run: () => Promise<CliResult>) => {
    setBusy(true);
    setError(null);
    run()
      .then((result) => {
        setStatus(result.status);
        setError(result.error ?? null);
      })
      .catch((failure: unknown) => setError(reason(failure)))
      .finally(() => setBusy(false));
  };

  const installed = status.state === "installed";
  const shown = installed && home && status.link.startsWith(`${home}/`) ? `~${status.link.slice(home.length)}` : null;
  return (
    <Group title="Command line">
      <Row
        id="crew-command"
        label={
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px]">crew</span> command
            {installed && <Chip tone={status.onPath ? "success" : "warning"}>{status.onPath ? "Installed" : "Not on your PATH"}</Chip>}
            {status.state === "unavailable" && <Chip tone="neutral">Unavailable</Chip>}
          </span>
        }
        description={
          error ? (
            <span className="text-danger">{error}</span>
          ) : installed ? (
            <span className="flex flex-wrap items-center gap-x-1">
              Linked at <span className="font-mono">{shown ?? status.link}</span>
              <CopyButton text={status.link} label="Copy path" className="size-5" />
              {!status.onPath && <span className="basis-full">That folder is not on your shell's PATH yet; add it to use crew by name.</span>}
            </span>
          ) : (
            describeCli(status)
          )
        }
      >
        {installed ? (
          <Button variant="ghost" loading={busy} onClick={() => act(() => host.uninstall())}>
            Uninstall
          </Button>
        ) : (
          <Button
            variant="secondary"
            loading={busy}
            disabled={status.state === "unavailable"}
            onClick={() => act(() => host.install())}
          >
            Install
          </Button>
        )}
      </Row>
    </Group>
  );
}
