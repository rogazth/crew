import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { nextRun, type Routine, type Schedule, type Session } from "@crew/fixtures";
import {
  Button,
  Card,
  Field,
  Input,
  ProviderMark,
  Row,
  Select,
  Switch,
  Textarea,
  type SelectOption,
} from "@/ui";
import { store, useApp } from "@/lib/store";
import { shortModel } from "@/lib/format";
import { TriggerControl, scheduleError } from "./TriggerControl";
import { RunHistory } from "./RunHistory";

type Draft = {
  name: string;
  prompt: string;
  schedule: Schedule;
  workspaceId: string;
  sessionId: string;
  enabled: boolean;
};

const firstAgent = (sessions: Session[], workspaceId: string): string =>
  sessions.find((s) => s.workspaceId === workspaceId && s.kind === "agent")?.id ?? "";

export function RoutineEditor({
  routine,
  saved,
  onSaved,
}: {
  routine: Routine;
  /** False while the routine is a local draft that Save has not persisted yet. */
  saved: boolean;
  onSaved: () => void;
}) {
  const state = useApp();
  const agentOf = (id: string) => state.sessions.find((s) => s.id === id);
  const [draft, setDraft] = useState<Draft>(() => ({
    name: routine.name,
    prompt: routine.prompt,
    schedule: routine.schedule,
    workspaceId: agentOf(routine.sessionId)?.workspaceId ?? state.workspaceId,
    sessionId: routine.sessionId,
    enabled: routine.enabled,
  }));

  const patch = (next: Partial<Draft>) => setDraft((held) => ({ ...held, ...next }));

  const cron = scheduleError(draft.schedule);
  const invalid = draft.name.trim().length === 0 || draft.sessionId === "" || cron !== null;
  const dirty =
    !saved ||
    draft.name !== routine.name ||
    draft.prompt !== routine.prompt ||
    draft.sessionId !== routine.sessionId ||
    draft.enabled !== routine.enabled ||
    JSON.stringify(draft.schedule) !== JSON.stringify(routine.schedule);

  const agents = state.sessions.filter(
    (session) => session.workspaceId === draft.workspaceId && session.kind === "agent",
  );
  const agent = agentOf(draft.sessionId);
  const title = draft.name.trim() || "new routine";

  const back = () => {
    if (!dirty) return store.openRoutines(null);
    store.confirm({
      title: `Discard changes to ${title}?`,
      description: "The edits on this page have not been saved.",
      action: "Discard",
      destructive: true,
      onConfirm: () => store.openRoutines(null),
    });
  };

  const save = () => {
    if (invalid) return;
    store.saveRoutine({
      ...routine,
      name: draft.name.trim(),
      prompt: draft.prompt,
      schedule: draft.schedule,
      sessionId: draft.sessionId,
      enabled: draft.enabled,
      nextRunAt: draft.enabled ? nextRun(draft.schedule) : null,
    });
    onSaved();
    store.notify(`Saved ${draft.name.trim()}`);
  };

  const remove = () => {
    store.confirm({
      title: saved ? `Delete ${title}?` : "Discard this routine?",
      description: saved
        ? "The routine and its run history go with it. This cannot be undone."
        : "It was never saved, so nothing else changes.",
      action: saved ? "Delete" : "Discard",
      destructive: true,
      onConfirm: () => {
        if (saved) store.deleteRoutine(routine.id);
        store.openRoutines(null);
        store.notify(saved ? `Deleted ${title}` : "Discarded the draft");
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <button
          type="button"
          onClick={back}
          className="rounded-[var(--r)] font-mono text-xs tracking-wide text-ink-3 uppercase hover:text-ink"
        >
          routines
        </button>
        <ChevronRight size={13} strokeWidth={1.25} className="shrink-0 text-ink-4" aria-hidden />
        <span className="truncate font-mono text-xs tracking-wide text-ink uppercase">{title}</span>
        {dirty ? (
          <span className="shrink-0 font-mono text-xs text-amber-ink">
            {saved ? "modified" : "unsaved"}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            onClick={() => {
              store.runRoutine(routine.id);
              store.notify(`Running ${title}`);
            }}
            disabled={!saved}
            {...(saved ? {} : { title: "Save the routine before running it." })}
          >
            Run now
          </Button>
          <Button variant="primary" onClick={save} disabled={invalid}>
            Save
          </Button>
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
        </div>
      </header>

      <div className="scroll min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 pt-8 pb-16">
          <Field label="Title" htmlFor="routine-name">
            <Input
              id="routine-name"
              mono
              spellCheck={false}
              value={draft.name}
              placeholder="Morning CI triage"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>

          <Field label="Triggers">
            <TriggerControl
              schedule={draft.schedule}
              onChange={(schedule) => patch({ schedule })}
            />
          </Field>

          <Field
            label="Instructions"
            htmlFor="routine-prompt"
            description="What the agent is told every time the routine fires."
          >
            <Textarea
              id="routine-prompt"
              rows={10}
              spellCheck={false}
              value={draft.prompt}
              placeholder="Read last night's CI failures and file the real regressions."
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </Field>

          <Field label="Workspace">
            <Select
              label="Workspace"
              value={draft.workspaceId}
              options={state.workspaces.map((workspace) => ({
                id: workspace.id,
                label: workspace.name,
              }))}
              onChange={(workspaceId) =>
                patch({ workspaceId, sessionId: firstAgent(state.sessions, workspaceId) })
              }
            />
          </Field>

          <Field
            label="Agent"
            {...(agent
              ? { description: `${agent.provider} · ${shortModel(agent.provider, agent.model)}` }
              : {})}
          >
            <Select
              label="Agent"
              value={draft.sessionId}
              placeholder={agents.length === 0 ? "No agents in this workspace" : "Choose an agent…"}
              disabled={agents.length === 0}
              {...(agent ? { lead: <ProviderMark provider={agent.provider} /> } : {})}
              options={agents.map(
                (session): SelectOption<string> => ({
                  id: session.id,
                  label: session.name,
                  note: shortModel(session.provider, session.model),
                  icon: <ProviderMark provider={session.provider} size={13} />,
                }),
              )}
              onChange={(sessionId) => patch({ sessionId })}
            />
          </Field>

          <Card>
            <Row
              label="Enabled"
              description="A paused routine keeps its history and its schedule, and stops firing."
              control={
                <Switch
                  label="Enabled"
                  checked={draft.enabled}
                  onChange={(enabled) => patch({ enabled })}
                />
              }
            />
          </Card>

          <RunHistory runs={routine.runs} />
        </div>
      </div>
    </div>
  );
}
