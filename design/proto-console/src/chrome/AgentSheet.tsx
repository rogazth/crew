import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@crew/fixtures";
import { Avatar, Button, Card, Field, Input, Kbd, Row, Switch, Textarea } from "@/ui";
import { useEscape } from "@/lib/hooks";
import { store, useApp } from "@/lib/store";
import { ModelPicker } from "./ModelPicker";

type Draft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  autonomy: "ask" | "full";
  notifications: boolean;
};

const EMPTY: Draft = {
  name: "",
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  description: "",
  autonomy: "ask",
  notifications: true,
};

export function AgentSheet() {
  const state = useApp();
  const open = state.overlay?.kind === "sheet";
  const editingId = state.overlay?.kind === "sheet" ? state.overlay.sessionId : null;
  const editing = editingId ? state.sessions.find((s) => s.id === editingId) : undefined;
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    if (!open) return;
    setDraft(
      editing
        ? {
            name: editing.name,
            provider: editing.provider,
            model: editing.model,
            description: editing.description,
            autonomy: editing.autonomy,
            notifications: editing.notifications,
          }
        : EMPTY,
    );
  }, [open, editing]);

  const close = () => store.closeOverlay();
  useEscape(close, open);

  const duplicate = state.sessions.some(
    (session) =>
      session.id !== editingId &&
      session.workspaceId === state.workspaceId &&
      session.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
  );
  const invalid = draft.name.trim().length === 0 || duplicate;

  const submit = () => {
    if (invalid) return;
    if (editing) {
      store.updateSession(editing.id, {
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model,
        description: draft.description,
        autonomy: draft.autonomy,
        notifications: draft.notifications,
      });
    } else {
      const session = store.createSession({
        kind: "agent",
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model,
        description: draft.description,
        autonomy: draft.autonomy,
        notifications: draft.notifications,
      });
      store.openSession(session.id);
    }
    close();
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 bg-ink opacity-20"
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={editing ? `Edit ${editing.name}` : "New agent"}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        style={{ animation: "slide-left var(--slow) var(--ease) both" }}
        className="relative z-10 flex h-full w-[380px] flex-col border-l border-rule bg-bg"
      >
        <header className="flex h-[var(--h-tabs)] shrink-0 items-center gap-2 border-b border-rule px-3">
          <span className="font-mono text-xs tracking-wide text-ink-3 uppercase">
            {editing ? "Edit agent" : "New agent"}
          </span>
          {editing ? (
            <span className="ml-auto font-mono text-xs text-ink-4">{editing.id}</span>
          ) : null}
        </header>

        <div className="scroll flex min-h-0 flex-1 flex-col gap-4 p-3">
          <div className="flex items-center gap-3">
            <Avatar seed={draft.name || "new agent"} size={44} />
            <div className="min-w-0 flex-1">
              <Field
                label="Name"
                htmlFor="agent-name"
                error={duplicate ? "An agent in this workspace already has that name." : null}
              >
                <Input
                  id="agent-name"
                  autoFocus
                  mono
                  value={draft.name}
                  invalid={duplicate}
                  placeholder="harness"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
            </div>
          </div>

          <Field label="Model">
            <ModelPicker
              provider={draft.provider}
              model={draft.model}
              onChange={(next) => setDraft({ ...draft, ...next })}
            />
          </Field>

          <Field label="Description" description="What this agent owns. The others read it.">
            <Textarea
              rows={4}
              value={draft.description}
              placeholder="Owns the provider harness: adapters, streaming, tool normalisation."
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>

          <Card>
            <Row
              label="Run autonomously"
              description="Skip the approval card and let the agent act."
              control={
                <Switch
                  label="Run autonomously"
                  checked={draft.autonomy === "full"}
                  onChange={(next) => setDraft({ ...draft, autonomy: next ? "full" : "ask" })}
                />
              }
            />
            <Row
              label="Notifications"
              description="Tell me when this agent finishes or needs an answer."
              control={
                <Switch
                  label="Notifications"
                  checked={draft.notifications}
                  onChange={(next) => setDraft({ ...draft, notifications: next })}
                />
              }
            />
          </Card>

          {editing ? (
            <>
              {editing.createdBy ? (
                <Card title="Created by">
                  <Row
                    label={
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          if (editing.createdBy) store.openSession(editing.createdBy.id);
                        }}
                        className="flex items-center gap-2 text-accent-ink hover:underline"
                      >
                        <Avatar seed={editing.createdBy.name} size={16} />
                        {editing.createdBy.name}
                      </button>
                    }
                    description="This agent was spawned by another agent."
                  />
                </Card>
              ) : null}
              <Button
                onClick={() => {
                  close();
                  store.openRoutines(null);
                }}
              >
                New routine…
              </Button>
            </>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-rule px-3 py-2">
          <Button onClick={close} kbd={<Kbd>Esc</Kbd>}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={invalid} kbd={<Kbd>⌘⏎</Kbd>}>
            {editing ? "Save" : "Create"}
          </Button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
