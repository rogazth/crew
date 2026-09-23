import { Button, Input, InputArea, Label, Switch } from "@cloudflare/kumo";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Kbd } from "./Kbd";
import { ModelPicker } from "./ModelPicker";
import { ProviderIcon } from "./ProviderIcon";
import type { useAgentSheet } from "../hooks/useAgentSheet";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import {
  agentNames,
  draftOf,
  nameError,
  shownError,
  type AgentDraft,
} from "../lib/agentSheet";
import type { ProviderId } from "../lib/providers";
import type { Session } from "../lib/types";

export type { AgentDraft } from "../lib/agentSheet";

type Props = {
  /** null = creating. */
  session: Session | null;
  existingNames: string[];
  /** null while creating: a routine needs an agent that already exists. */
  onNewRoutine: (() => void) | null;
  onSave: (draft: AgentDraft) => Promise<void>;
  onClose: () => void;
};

/** Must match .sheet-panel-out in index.css. */
const CLOSE_MS = 150;

/** The open sheet, keyed so switching between agents starts a fresh draft. */
export function AgentSheetHost({
  sheet,
  sessions,
  onNewRoutine,
}: {
  sheet: ReturnType<typeof useAgentSheet>;
  sessions: Session[];
  onNewRoutine: (sessionId: string) => void;
}) {
  if (!sheet.sheet) return null;
  const editing = sheet.sheet.session;
  return (
    <AgentSheet
      key={editing?.id ?? "new"}
      session={editing}
      existingNames={agentNames(sessions)}
      onNewRoutine={editing ? () => onNewRoutine(editing.id) : null}
      onSave={sheet.save}
      onClose={sheet.close}
    />
  );
}

export function AgentSheet({ session, existingNames, onNewRoutine, onSave, onClose }: Props) {
  // Seeded once per mount (the parent keys us by session): the CLI probe landing
  // mid-edit must not wipe what was typed.
  const { effective } = useDefaultAgent();
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(session, effective));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  // The parent unmounts us the moment onClose fires, so the exit has to play first.
  const requestClose = useCallback(() => {
    if (closeTimer.current !== null) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  const name = draft.name.trim();
  const { taken, error } = nameError(name, existingNames, session?.name);

  async function submit() {
    setSubmitted(true);
    if (error || saving || closing) return;
    setSaving(true);
    try {
      // onSave holds the spinner for MIN_SAVE_MS so its result and this exit coincide.
      await onSave({ ...draft, name });
      requestClose();
    } catch {
      setSaving(false);
    }
  }

  // Saving adds the name to existingNames, so validation would flash "already
  // exists" over the agent we just created while the sheet plays its exit.
  const showError = shownError({ error, taken, submitted, busy: saving || closing });

  // Window-level so Escape works after clicking non-focusable content in the drawer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div
      role="presentation"
      className={`fixed inset-0 z-40 flex justify-end ${closing ? "pointer-events-none" : ""}`}
      onClick={requestClose}
    >
      <div
        className={`absolute inset-0 bg-black/10 backdrop-blur-[1px] ${
          closing ? "sheet-backdrop-out" : "sheet-backdrop"
        }`}
      />
      <aside
        onClick={(event) => event.stopPropagation()}
        className={`relative flex h-full w-[380px] flex-col border-l border-border bg-canvas shadow-2xl ${
          closing ? "sheet-panel-out" : "sheet-panel"
        }`}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-4">
          <span className="font-medium">{session ? "Agent settings" : "New agent"}</span>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            icon={<XIcon className="size-4" />}
            aria-label="Close"
            onClick={requestClose}
          />
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <AgentFields draft={draft} error={showError} onChange={setDraft} />

          {onNewRoutine && (
            <Button
              variant="secondary"
              className="w-full"
              icon={PlusIcon}
              onClick={() => {
                requestClose();
                onNewRoutine();
              }}
            >
              New routine
            </Button>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3">
          <Button variant="secondary" onClick={requestClose}>
            Cancel <Kbd keys="Esc" />
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {session ? "Save" : "Create agent"}{" "}
            <Kbd keys="⌘⏎" className="border-white/20 bg-white/10 text-white/80" />
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function AgentFields({
  draft,
  error,
  onChange,
}: {
  draft: AgentDraft;
  error: string | undefined;
  onChange: (draft: AgentDraft) => void;
}) {
  const update = (patch: Partial<AgentDraft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <div className="flex justify-center pt-2 pb-1">
        <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-sidebar">
          <ProviderIcon provider={draft.provider} className="size-7" />
        </div>
      </div>

      <Input
        autoFocus
        label="Name"
        className="w-full"
        value={draft.name}
        placeholder="e.g. research"
        {...(error ? { error } : {})}
        variant={error ? "error" : "default"}
        onChange={(e) => update({ name: e.target.value })}
      />

      <div className="flex flex-col gap-1.5">
        <Label>Model</Label>
        <ModelPicker
          provider={draft.provider}
          model={draft.model}
          onChange={(provider: ProviderId, model) => update({ provider, model })}
        />
      </div>

      <InputArea
        label="Description"
        className="w-full"
        rows={4}
        value={draft.description}
        placeholder="What this agent is for, and how it should work"
        onChange={(e) => update({ description: e.target.value })}
      />

      <div className="rounded-xl border border-border bg-sidebar p-3">
        <Switch
          variant="neutral"
          controlFirst={false}
          checked={draft.autonomy === "full"}
          onCheckedChange={(checked) => update({ autonomy: checked ? "full" : "ask" })}
          label={
            <span className="block">
              <span className="block font-medium">Run autonomously</span>
              <span className="mt-0.5 block font-normal text-kumo-subtle">
                Tools run without asking. Off means every edit and command waits for Allow
              </span>
            </span>
          }
        />
      </div>

      <div className="rounded-xl border border-border bg-sidebar p-3">
        <Switch
          variant="neutral"
          controlFirst={false}
          checked={draft.notifications}
          onCheckedChange={(checked) => update({ notifications: checked })}
          label={
            <span className="block">
              <span className="block font-medium">Notifications</span>
              <span className="mt-0.5 block font-normal text-kumo-subtle">
                Get notified when this agent finishes or needs input
              </span>
            </span>
          }
        />
      </div>
    </>
  );
}
