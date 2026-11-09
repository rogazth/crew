import { Trash2Icon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { BackLink, Button, IconButton, PAGE_TITLE, Switch } from "../chrome/kit";
import * as api from "../lib/api";
import { SUBMIT_KEYS } from "../lib/hotkey";
import { formatEnv, isLive, originOf, parseEnv, specOf, type Process, type ProcessSpec } from "../lib/processes";
import type { Session } from "../lib/types";
import { OriginTag } from "./ServiceParts";

type Props = {
  workspaceId: string;
  /** Absent for a new service. */
  process?: Process | undefined;
  sessions: Session[];
  onBack: () => void;
  /** A new service saved: back to the list, which says so. */
  onCreated: (process: Process) => void;
  onDelete: () => void;
};

/**
 * Every field of the form alike: filled with the settings' card tone, no
 * outline until it has the focus, the text in the terminal's face.
 */
const FIELD =
  "w-full rounded-lg bg-card px-3 font-mono text-[12.5px] leading-5 outline-none transition-shadow placeholder:text-placeholder";

/** A field under its label, set in a settings row's type. */
function Item({ label, error, children }: { label: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] leading-[18px] font-medium">
        {label}
      </label>
      {children(id)}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}

type Draft = { name: string; command: string; cwd: string; envText: string; autoRestart: boolean };

const EMPTY: ProcessSpec = { name: "", command: "", cwd: "", env: {}, autoRestart: false };

const toDraft = (spec: ProcessSpec): Draft => ({
  name: spec.name,
  command: spec.command,
  cwd: spec.cwd,
  envText: formatEnv(spec.env),
  autoRestart: spec.autoRestart,
});

const same = (a: Draft, b: Draft) =>
  a.name.trim() === b.name.trim() &&
  a.command.trim() === b.command.trim() &&
  a.cwd.trim() === b.cwd.trim() &&
  a.envText.trim() === b.envText.trim() &&
  a.autoRestart === b.autoRestart;

/**
 * One service's definition, full page, the way a routine opens: its name as
 * the title, what it runs under it, and a way to delete it. Running it is the
 * list's. A change an agent makes while it is open lands here too, unless the
 * user is mid-edit.
 */
export function ServiceEditor({
  workspaceId,
  process,
  sessions,
  onBack,
  onCreated,
  onDelete,
}: Props) {
  const live = process ? specOf(process) : EMPTY;
  const liveKey = JSON.stringify(live);
  const [base, setBase] = useState(() => toDraft(live));
  const [draft, setDraft] = useState(base);
  const [seen, setSeen] = useState(liveKey);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** It changed under the user's own edits: Save sends only what they changed, and says so. */
  const [moved, setMoved] = useState(false);
  const dirty = !same(draft, base);
  // The definition moved under the page (an agent changed it): take it, unless the user has edits of their own.
  if (seen !== liveKey) {
    setSeen(liveKey);
    if (!dirty) {
      setBase(toDraft(live));
      setDraft(toDraft(live));
    } else setMoved(true);
  }

  const env = parseEnv(draft.envText);
  const valid = draft.name.trim() !== "" && draft.command.trim() !== "" && env.env !== null;
  const canSave = valid && (process ? dirty : true) && !saving;
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  async function save() {
    if (!canSave || env.env === null) return;
    const spec: ProcessSpec = {
      name: draft.name.trim(),
      command: draft.command.trim(),
      cwd: draft.cwd.trim(),
      env: env.env,
      autoRestart: draft.autoRestart,
    };
    // Only what the user changed from what they opened: a field an agent changed meanwhile keeps the agent's.
    const patch: Partial<ProcessSpec> = {
      ...(draft.name.trim() !== base.name.trim() && { name: spec.name }),
      ...(draft.command.trim() !== base.command.trim() && { command: spec.command }),
      ...(draft.cwd.trim() !== base.cwd.trim() && { cwd: spec.cwd }),
      ...(draft.envText.trim() !== base.envText.trim() && { env: spec.env }),
      ...(draft.autoRestart !== base.autoRestart && { autoRestart: spec.autoRestart }),
    };
    setSaving(true);
    setFailure(null);
    try {
      const saved = process ? await api.updateProcess(workspaceId, process.id, patch) : await api.createProcess(workspaceId, spec);
      if (process) {
        setBase(toDraft(specOf(saved)));
        setDraft(toDraft(specOf(saved)));
        setMoved(false);
      } else onCreated(saved);
    } catch (error) {
      setFailure(String(error).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  }

  const origin = process ? originOf(process, sessions) : null;

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* PageFrame's measure, so the way back and name line up with the Services page. */}
        <div className="mx-auto flex max-w-[720px] flex-col gap-7 px-10 pt-12 pb-8">
          <div className="flex flex-col gap-2">
            {/* A step clear of the title, so it reads as navigation, not a label. */}
            <BackLink onClick={onBack} className="mb-2" />
            <header className="flex items-center gap-3 px-1">
              {/* The name is the page's title, typed in place. */}
              <input
                autoFocus={!process}
                spellCheck={false}
                aria-label="Name"
                value={draft.name}
                placeholder="Service name"
                onChange={(event) => set({ name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) event.currentTarget.blur();
                }}
                className={`h-7 min-w-0 flex-1 truncate bg-transparent ${PAGE_TITLE} outline-none placeholder:text-placeholder`}
              />
              {process && (
                <IconButton
                  icon={Trash2Icon}
                  label="Delete service"
                  title="Delete service"
                  className="hover:bg-danger/10 hover:text-danger"
                  onClick={onDelete}
                />
              )}
            </header>
            {origin?.kind === "session" && (
              <p data-origin-line className="-mt-1 px-1 text-[12.5px] text-text-muted">
                Created by <OriginTag origin={origin} />
              </p>
            )}
          </div>

          <div className="flex flex-col gap-6 px-1">
            <Item label="Command">
              {(id) => (
                // A terminal's line: the prompt, then what it runs, in one field.
                <div className={`${FIELD} flex items-start gap-2 py-2 focus-within:ring-[1.5px] focus-within:ring-focus/50`}>
                  <span aria-hidden className="text-text-muted select-none">
                    $
                  </span>
                  <textarea
                    id={id}
                    spellCheck={false}
                    value={draft.command}
                    placeholder="npm run dev"
                    onChange={(event) => set({ command: event.target.value })}
                    className="block min-h-5 min-w-0 flex-1 resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-placeholder"
                  />
                </div>
              )}
            </Item>
            <Item label="Folder">
              {(id) => (
                <input
                  id={id}
                  spellCheck={false}
                  value={draft.cwd}
                  placeholder="Worktree root"
                  onChange={(event) => set({ cwd: event.target.value })}
                  className={`${FIELD} h-9 placeholder:font-sans focus:ring-[1.5px] focus:ring-focus/50`}
                />
              )}
            </Item>
            <Item label="Environment" error={env.error}>
              {(id) => (
                <textarea
                  id={id}
                  spellCheck={false}
                  value={draft.envText}
                  placeholder="PORT=3000"
                  aria-invalid={env.error !== null}
                  onChange={(event) => set({ envText: event.target.value })}
                  className={`${FIELD} block min-h-[60px] resize-none py-2 [field-sizing:content] focus:ring-[1.5px] focus:ring-focus/50 aria-invalid:ring-[1.5px] aria-invalid:ring-danger/60`}
                />
              )}
            </Item>
            {/* A form's switch goes before its label, as a checkbox would: the two read as one. */}
            <label className="flex cursor-pointer items-center gap-2.5 self-start select-none">
              <Switch checked={draft.autoRestart} onChange={(autoRestart) => set({ autoRestart })} />
              <span className="text-[13px] leading-[18px] font-medium">Restart on crash</span>
            </label>
          </div>

        </div>
      </div>
      {/* No rule over it: what scrolls fades into it. */}
      <div className="relative mx-auto flex w-full max-w-[720px] shrink-0 items-center justify-end gap-2 px-10 pt-1 pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-canvas before:to-transparent">
        {failure ? (
          <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger">
            {failure}
          </p>
        ) : process && dirty && moved ? (
          <p className="mr-auto min-w-0 truncate text-[12px] text-text-muted">Changed while you edited: Save keeps only your changes.</p>
        ) : (
          process &&
          dirty &&
          process.runs.some(isLive) && <p className="mr-auto text-[12px] text-text-muted">Running copies pick it up on their next restart.</p>
        )}
        <Button variant="ghost" onClick={onBack}>
          {process ? "Back" : "Cancel"}
        </Button>
        <Button variant="primary" title={SUBMIT_KEYS} disabled={!canSave} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
