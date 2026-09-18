import clsx from "clsx";
import { dayLabel, duration, type RoutineRun, type RunStatus } from "@crew/fixtures";
import { Badge, Bars, Card } from "@/ui";
import { useNow } from "@/lib/hooks";

export function RunHistory({ runs }: { runs: RoutineRun[] }) {
  return (
    <Card title="Run history">
      {runs.length === 0 ? (
        <p className="px-3 py-3 text-sm text-ink-3">
          Nothing has run yet. Run now to see the first entry here.
        </p>
      ) : (
        runs.map((run) => (
          <div
            key={run.id}
            className="flex h-[var(--row-h)] items-center gap-2 border-b border-rule px-3 last:border-b-0"
          >
            <RunMark status={run.status} />
            <span className="truncate font-mono text-sm text-ink-2">{dayLabel(run.startedAt)}</span>
            {run.trigger === "manual" ? <Badge>manual</Badge> : null}
            <span className="ml-auto shrink-0 font-mono text-sm text-ink-3">
              {run.status === "running" ? (
                <Elapsed since={run.startedAt} />
              ) : run.finishedAt !== null && run.finishedAt > run.startedAt ? (
                duration(run.finishedAt - run.startedAt)
              ) : (
                "—"
              )}
            </span>
          </div>
        ))
      )}
    </Card>
  );
}

const GLYPH: Record<Exclude<RunStatus, "running">, { mark: string; tone: string; label: string }> = {
  ok: { mark: "✓", tone: "text-green-ink", label: "Succeeded" },
  error: { mark: "✕", tone: "text-red-ink", label: "Failed" },
  skipped: { mark: "–", tone: "text-ink-4", label: "Skipped" },
};

export function RunMark({ status, className }: { status: RunStatus; className?: string }) {
  const shared = "inline-grid size-[12px] shrink-0 place-items-center font-mono text-xs leading-none";
  if (status === "running") {
    return (
      <span className={clsx(shared, "text-amber", className)} role="img" aria-label="Running">
        <Bars />
      </span>
    );
  }
  const glyph = GLYPH[status];
  return (
    <span className={clsx(shared, glyph.tone, className)} role="img" aria-label={glyph.label}>
      {glyph.mark}
    </span>
  );
}

/** A running row counts up, so a manual run reads as alive and not as stuck. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(1_000);
  return <>{duration(Math.max(1_000, now - since))}</>;
}
