import { useEffect, useState } from "react";
import {
  TRIGGERS,
  WEEKDAYS,
  isValidCron,
  triggerOf,
  withTrigger,
  type Schedule,
  type TriggerId,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Button } from "@/ui/Button";
import { Field, Section } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Input, Textarea } from "@/ui/Input";
import { Select } from "@/ui/Select";
import { Toggle } from "@/ui/Toggle";
import { RunHistory } from "./Routines";

export function RoutineEditor({ id }: { id: string }) {
  const { routines, updateRoutine, deleteRoutine, runRoutine, setPage, wsSessions, workspaces, workspaceId, setConfirmRequest, toast } =
    useStore();
  const routine = routines.find((entry) => entry.id === id);

  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? { kind: "interval", minutes: 60 });
  const [sessionId, setSessionId] = useState(routine?.sessionId ?? "s-triage");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [ws, setWs] = useState(workspaceId);

  useEffect(() => {
    if (!routine) return;
    setName(routine.name);
    setPrompt(routine.prompt);
    setSchedule(routine.schedule);
    setSessionId(routine.sessionId);
    setEnabled(routine.enabled);
  }, [routine]);

  if (!routine) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <button type="button" onClick={() => setPage({ kind: "routines" })} className="text-base text-accent-text">
          That routine is gone. Back to routines.
        </button>
      </div>
    );
  }

  const trigger = triggerOf(schedule);
  const cronMessage =
    schedule.kind === "cron" && !isValidCron(schedule.expression)
      ? "Five fields: minute hour day-of-month month day-of-week."
      : null;
  const time = schedule.kind === "daily" ? `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}` : "09:00";

  const save = () => {
    updateRoutine(id, { name, prompt, schedule, sessionId, enabled });
    toast("Routine saved");
  };

  return (
    <div className="scroller min-h-0 flex-1">
      <div className="mx-auto w-full max-w-[720px] px-8 pb-16 pt-8">
        <button
          type="button"
          onClick={() => setPage({ kind: "routines" })}
          className="mb-4 flex items-center gap-1.5 text-sm text-ink-52 hover:text-ink"
        >
          <Icon name="chevronLeft" size={14} />
          Routines
        </button>

        <div className="mb-6 flex items-end justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl">{name || "Untitled routine"}</h1>
          <div className="flex shrink-0 items-center gap-2">
            <Button icon="play" onClick={() => runRoutine(id)}>
              Run now
            </Button>
            <Button variant="primary" onClick={save}>
              Save
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              aria-label="Delete routine"
              onClick={() =>
                setConfirmRequest({
                  title: `Delete ${routine.name}?`,
                  description: "The schedule stops and the run history goes with it.",
                  actionLabel: "Delete routine",
                  destructive: true,
                  onConfirm: () => {
                    deleteRoutine(id);
                    setPage({ kind: "routines" });
                  },
                })
              }
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <Field label="Title">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Morning CI triage" />
          </Field>

          <Field label="Triggers" hint="When the agent gets woken up.">
            <div className="flex flex-col gap-2.5 rounded-card bg-raised p-3.5 el-1">
              <Select
                value={trigger}
                onChange={(next) => setSchedule(withTrigger(schedule, next as TriggerId))}
                options={TRIGGERS.map((entry) => ({ value: entry.id, label: entry.label }))}
                className="w-full"
              />

              {(trigger === "daily" || trigger === "weekly") && (
                <div className="flex items-center gap-2">
                  <label className="text-sm text-ink-52" htmlFor="routine-time">
                    at
                  </label>
                  <Input
                    id="routine-time"
                    type="time"
                    value={time}
                    onChange={(event) => {
                      const [hour, minute] = event.target.value.split(":").map(Number);
                      setSchedule((held) =>
                        held.kind === "daily" ? { ...held, hour: hour ?? 9, minute: minute ?? 0 } : held,
                      );
                    }}
                    className="h-8 w-[120px]"
                  />
                </div>
              )}

              {trigger === "weekly" && schedule.kind === "daily" && (
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((label, index) => {
                    const on = schedule.days.includes(index);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          setSchedule((held) =>
                            held.kind === "daily"
                              ? {
                                  ...held,
                                  days: on ? held.days.filter((d) => d !== index) : [...held.days, index].sort(),
                                }
                              : held,
                          )
                        }
                        className={cx(
                          "rise-1 h-7 rounded-chip px-2.5 text-sm",
                          on ? "bg-accent text-on-accent el-1" : "bg-sunken text-ink-52 hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {trigger === "cron" && schedule.kind === "cron" && (
                <div>
                  <Input
                    value={schedule.expression}
                    onChange={(event) => setSchedule({ kind: "cron", expression: event.target.value })}
                    placeholder="0 4 * * 1"
                    className={cx("font-mono", cronMessage && "shadow-[var(--e2),0_0_0_3px_var(--danger-soft)]")}
                  />
                  <p className={cx("mt-1.5 text-sm", cronMessage ? "text-[var(--danger)]" : "text-ink-52")}>
                    {cronMessage ?? "minute hour day-of-month month day-of-week"}
                  </p>
                </div>
              )}
            </div>
          </Field>

          <Field label="Instructions">
            <Textarea rows={10} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Workspace">
              <Select
                value={ws}
                onChange={setWs}
                options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                className="w-full"
              />
            </Field>
            <Field label="Agent">
              <Select
                value={sessionId}
                onChange={setSessionId}
                options={wsSessions
                  .filter((session) => session.kind === "agent")
                  .map((session) => ({ value: session.id, label: session.name }))}
                className="w-full"
              />
            </Field>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-card bg-raised px-3.5 py-3 el-1">
            <div>
              <p className="text-base text-ink">Enabled</p>
              <p className="mt-0.5 text-sm text-ink-52">
                A paused routine keeps its schedule and its history but never fires.
              </p>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
          </div>

          <Section title="Run history">
            <RunHistory runs={routine.runs} />
          </Section>
        </div>
      </div>
    </div>
  );
}
