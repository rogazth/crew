import { useEffect, useState } from "react";
import { Button, Footer, Overlay } from "./kit";
import * as api from "../lib/api";
import { formatEnv } from "../lib/processes";
import type { SoloEntry, SoloImported } from "../lib/protocol";

type Props = {
  workspaceId: string;
  onClose: () => void;
  /** After an import, with what was created and what was left alone. */
  onImported: (imported: SoloImported) => void;
};

/**
 * What `solo.yml` would add, read before anything is created: Solo starts a
 * command with the app unless told otherwise, and a file in the workspace is
 * anyone's to write. What is imported is what this showed, not the file as
 * it is by the time the user says yes.
 */
export function SoloImportDialog({ workspaceId, onClose, onImported }: Props) {
  const [entries, setEntries] = useState<SoloEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .soloPreview(workspaceId)
      .then((list) => !cancelled && setEntries(list))
      .catch((error: unknown) => !cancelled && setFailure(String(error).replace(/^Error:\s*/, "")));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const fresh = entries?.filter((entry) => !entry.exists) ?? [];

  async function confirm() {
    if (busy || fresh.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const specs = fresh.map(({ name, command, cwd, env, autoStart, autoRestart }) => ({
        name,
        command,
        cwd,
        env,
        autoStart,
        autoRestart,
      }));
      onImported(await api.importSoloYml(workspaceId, specs));
      onClose();
    } catch (error) {
      setFailure(String(error).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose} width="w-[520px]" label="Import from solo.yml">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <div className="text-[14px] font-semibold">Import from solo.yml</div>
        {entries === null && !failure && <p className="text-kumo-subtle">Reading solo.yml…</p>}
        {entries?.length === 0 && <p className="text-kumo-subtle">solo.yml lists no commands.</p>}
        {entries && entries.length > 0 && (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.name}
                className={`flex flex-col gap-1 rounded-lg p-2.5 ring-1 ring-kumo-line ${entry.exists ? "opacity-60" : ""}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
                  {entry.exists && (
                    <span className="shrink-0 text-[11px] text-kumo-subtle">Already exists, skipped</span>
                  )}
                </div>
                <code className="font-mono text-[12px] break-words whitespace-pre-wrap">
                  {entry.cwd ? `${entry.cwd} $ ` : "$ "}
                  {entry.command}
                </code>
                {Object.keys(entry.env).length > 0 && (
                  <code className="font-mono text-[11px] whitespace-pre-wrap text-kumo-subtle">{formatEnv(entry.env)}</code>
                )}
                <span className="text-[11px] text-kumo-subtle">
                  {[entry.autoStart ? "Starts with Crew" : "Starts by hand", entry.autoRestart ? "restarts on crash" : null]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {failure && <p className="text-[12px] text-kumo-danger">{failure}</p>}
      </div>
      <Footer hints={[["esc", "cancel"]]}>
        <Button variant="ghost" className="text-[12px]" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="text-[12px]"
          loading={busy}
          disabled={fresh.length === 0}
          onClick={() => void confirm()}
        >
          {fresh.length === 1 ? "Import 1 command" : `Import ${fresh.length} commands`}
        </Button>
      </Footer>
    </Overlay>
  );
}
