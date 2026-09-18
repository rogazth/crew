import { useState } from "react";
import { dayLabel, describeSchedule, duration, nextRun, summarizePrompt } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Empty } from "@/ui/Empty";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Segmented } from "@/ui/Segmented";

export function RoutinesPage() {
  const { routines, sessionById, setPage, createRoutine } = useStore();
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");

  const shown = routines.filter((routine) =>
    filter === "all" ? true : filter === "active" ? routine.enabled : !routine.enabled,
  );

  return (
    <div className="scroller min-h-0 flex-1">
      <div className="mx-auto w-full max-w-[980px] px-8 pb-16 pt-10">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl">Routines</h1>
            <p className="mt-1 text-base text-ink-52">A standing order: an agent, a prompt, a schedule.</p>
          </div>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              const id = createRoutine();
              setPage({ kind: "routine", id });
            }}
          >
            New routine
          </Button>
        </div>

        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: routines.length },
            { value: "active", label: "Active", count: routines.filter((r) => r.enabled).length },
            { value: "paused", label: "Paused", count: routines.filter((r) => !r.enabled).length },
          ]}
        />

        {shown.length === 0 ? (
          <Empty icon="repeat" title="No routines here" description="Routines run an agent on a schedule without you asking." />
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {shown.map((routine) => {
              const session = sessionById(routine.sessionId);
              const failed = routine.runs[0]?.status === "error";
              const next = routine.enabled ? nextRun(routine.schedule) : null;
              return (
                <button
                  key={routine.id}
                  type="button"
                  onClick={() => setPage({ kind: "routine", id: routine.id })}
                  className="rise-1 flex flex-col gap-2.5 rounded-card bg-raised p-4 text-left el-1"
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar seed={session?.name ?? routine.sessionId} size={28} />
                    <span className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{routine.name}</span>
                    {!routine.enabled && <Badge>Paused</Badge>}
                    {failed && (
                      <Badge tone="danger">
                        <Icon name="circleAlert" size={11} />
                        last run failed
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-2 text-sm text-ink-52">{routine.prompt ? summarizePrompt(routine.prompt) : "No instructions yet."}</p>
                  <div className="flex items-center gap-2 text-xs text-ink-38">
                    <Icon name="clock" size={12} />
                    {describeSchedule(routine.schedule)}
                    <Icon name="arrowRight" size={12} />
                    {session?.name ?? routine.sessionId}
                    {routine.enabled && next !== null && (
                      <>
                        <span className="opacity-50">·</span>
                        <span>next {dayLabel(next)}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const RUN_GLYPH: Record<string, GlyphName> = {
  running: "circleDot",
  ok: "circleCheck",
  skipped: "circleMinus",
  error: "circleX",
};

const RUN_TONE: Record<string, string> = {
  running: "text-accent-text",
  ok: "text-[var(--ok)]",
  skipped: "text-ink-38",
  error: "text-[var(--danger)]",
};

export function RunHistory({ runs }: { runs: import("@crew/fixtures").RoutineRun[] }) {
  if (runs.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-ink-38">No runs yet.</p>;
  }
  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id} className="flex items-center gap-3 border-b border-[var(--line-soft)] px-4 py-2.5 last:border-b-0">
          <span className={cx("shrink-0", RUN_TONE[run.status])}>
            <Icon name={RUN_GLYPH[run.status] ?? "circleDot"} size={15} className={run.status === "running" ? "pulse-dot" : ""} />
          </span>
          <span className="flex-1 truncate text-sm text-ink-70">{dayLabel(run.startedAt)}</span>
          {run.trigger === "manual" && <Badge>manual</Badge>}
          <span className="shrink-0 text-xs tabular-nums text-ink-38">
            {run.finishedAt ? duration(run.finishedAt - run.startedAt) : "running"}
          </span>
        </li>
      ))}
    </ul>
  );
}
