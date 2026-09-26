import { useCallback, useState } from "react";
import { Button, Field, Footer, Overlay, TextArea, TextInput, Toggle } from "./kit";
import * as api from "../lib/api";
import { formatEnv, isLive, parseEnv, type Process, type ProcessSpec } from "../lib/processes";

type Props = {
  workspaceId: string;
  /** Absent for a new command. */
  process?: Process | undefined;
  onClose: () => void;
  /** After a save, with the row the daemon answered. */
  onSaved?: ((process: Process) => void) | undefined;
};

const EMPTY: ProcessSpec = { name: "", command: "", cwd: "", env: {}, autoStart: false, autoRestart: false };

/** A command's definition. The user writes it, so it runs without asking anyone. */
export function ProcessDialog({ workspaceId, process, onClose, onSaved }: Props) {
  const initial = process ?? EMPTY;
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [cwd, setCwd] = useState(initial.cwd);
  const [envText, setEnvText] = useState(() => formatEnv(initial.env));
  const [autoStart, setAutoStart] = useState(initial.autoStart);
  const [autoRestart, setAutoRestart] = useState(initial.autoRestart);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const focus = useCallback((node: HTMLInputElement | null) => node?.focus(), []);

  const env = parseEnv(envText);
  const ready = name.trim() !== "" && command.trim() !== "" && env.env !== null;

  async function save() {
    if (!ready || busy || env.env === null) return;
    const spec: ProcessSpec = { name: name.trim(), command: command.trim(), cwd: cwd.trim(), env: env.env, autoStart, autoRestart };
    setBusy(true);
    setFailure(null);
    try {
      const saved = process
        ? await api.updateProcess(workspaceId, process.id, spec)
        : await api.createProcess(workspaceId, spec);
      onSaved?.(saved);
      onClose();
    } catch (error) {
      setFailure(String(error).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose} width="w-[480px]" label={process ? `Edit ${process.name}` : "New command"}>
      <form
        className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          // ↵ in a one-line field saves; in the text areas it is a new line, and ⌘↵ saves.
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void save();
        }}
      >
        <div className="text-[14px] font-semibold">{process ? "Edit command" : "New command"}</div>
        <Field label="Name">
          <TextInput ref={focus} value={name} placeholder="Dev server" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Command" hint="Runs in your shell, so pipes and && work.">
          <TextArea
            value={command}
            placeholder="npm run dev"
            rows={2}
            className="min-h-0 font-mono text-[12px]"
            onChange={(event) => setCommand(event.target.value)}
          />
        </Field>
        <Field label="Folder" hint="Relative to the workspace. Leave empty for its root.">
          <TextInput value={cwd} placeholder="." className="font-mono text-[12px]" onChange={(event) => setCwd(event.target.value)} />
        </Field>
        <Field label="Environment" error={env.error}>
          <TextArea
            value={envText}
            placeholder="PORT=3000"
            rows={2}
            className="min-h-0 font-mono text-[12px]"
            aria-invalid={env.error !== null}
            onChange={(event) => setEnvText(event.target.value)}
          />
        </Field>
        <div className="-my-1 flex flex-col">
          <Toggle label="Start with Crew" description="Starts whenever Crew opens." checked={autoStart} onChange={setAutoStart} />
          <Toggle
            label="Restart on crash"
            description="Waits longer after each crash. Five in two minutes and it stays down."
            checked={autoRestart}
            onChange={setAutoRestart}
          />
        </div>
        {process && isLive(process) && (
          <p className="text-[12px] text-kumo-subtle">It keeps running as it is until you restart it.</p>
        )}
        {failure && <p className="text-[12px] text-kumo-danger">{failure}</p>}
        <button type="submit" hidden />
      </form>
      <Footer hints={[["⌘↵", "save"], ["esc", "cancel"]]}>
        <Button variant="ghost" className="text-[12px]" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" className="text-[12px]" loading={busy} disabled={!ready} onClick={() => void save()}>
          {process ? "Save" : "Add command"}
        </Button>
      </Footer>
    </Overlay>
  );
}
