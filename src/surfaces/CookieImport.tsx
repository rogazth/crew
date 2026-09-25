import { useEffect, useState } from "react";
import { Button, Select, type Option } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { browserCookieSources, browserCookiesRead } from "../lib/api";
import { browserHost } from "../lib/host";
import type { CookieSource } from "../lib/protocol";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

function label(source: CookieSource): string {
  return source.profile ? `${source.browser} — ${source.profile}` : source.browser;
}

function summary(source: CookieSource, imported: number, left: number): string {
  const count = `${imported.toLocaleString()} cookie${imported === 1 ? "" : "s"}`;
  const rest = left > 0 ? ` ${left.toLocaleString()} couldn't be brought over.` : "";
  return `Imported ${count} from ${label(source)}.${rest}`;
}

/** Copies another browser's sign-ins into Crew's pages. Only in Electron: main writes the cookies. */
export function CookieImport() {
  const host = browserHost();
  const [sources, setSources] = useState<CookieSource[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (!host) return;
    let live = true;
    browserCookieSources()
      .then((found) => {
        if (!live) return;
        setSources(found);
        setChosen(found[0]?.id ?? "");
      })
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, [host]);

  if (!host || !sources) return null;

  async function run() {
    const source = sources?.find((s) => s.id === chosen);
    if (!host || !source) return;
    setStatus({ kind: "busy" });
    try {
      const read = await browserCookiesRead(source.id);
      const written = await host.importCookies(read.cookies);
      setStatus({ kind: "done", text: summary(source, written.imported, read.skipped + written.failed) });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  const options = sources.map((source): Option<string> => ({ value: source.id, label: label(source) }));
  const description =
    status.kind === "done" || status.kind === "error"
      ? status.text
      : sources.length === 0
        ? "No Chromium browser with cookies was found on this Mac."
        : "Pages open signed in where that browser is. macOS asks to let Crew read the browser's keychain entry. Google accounts stay behind.";

  return (
    <SettingsSection title="Cookies">
      <SettingsRow label="Import from a browser" description={description}>
        {sources.length > 0 && (
          <>
            <Select label="Browser profile" className="w-52" value={chosen} onChange={setChosen} options={options} />
            <Button loading={status.kind === "busy"} onClick={() => void run()}>
              Import
            </Button>
          </>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
