import { useEffect, useState } from "react";
import { Button } from "../../chrome/kit";
import { SettingsRow, SettingsSection } from "../../chrome/SettingsRow";
import { describeCli, type CliResult, type CliStatus } from "../../lib/cli";
import { cliHost } from "../../lib/host";

/** The `crew` command for the user's own terminal. Only in the app: a browser has no PATH to link into. */
export function CommandLineSettings() {
  const host = cliHost();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    host
      ?.status()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => {});
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
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection title="Command line">
      <SettingsRow label="crew command" description={error ?? describeCli(status)}>
        {status.state === "installed" ? (
          <Button variant="ghost" className="h-7 text-[12px]" loading={busy} onClick={() => act(() => host.uninstall())}>
            Uninstall
          </Button>
        ) : (
          <Button
            className="h-7 text-[12px]"
            loading={busy}
            disabled={status.state === "unavailable"}
            onClick={() => act(() => host.install())}
          >
            Install
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
