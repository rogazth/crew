import type { Routine, RoutineRun } from "../types";
import { NOW } from "./workspace";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NERB = { id: "s-relay", name: "Relay" };

function runs(spec: Array<[RoutineRun["status"], number, number | null, RoutineRun["trigger"]?]>): RoutineRun[] {
  return spec.map(([status, startedAt, finishedAt, trigger = "schedule"], i) => ({
    id: `run-${startedAt}-${i}`,
    startedAt,
    finishedAt,
    status,
    trigger,
  }));
}

export const routines: Routine[] = [
  {
    id: "r-triage",
    sessionId: "s-triage",
    name: "Morning CI triage",
    enabled: true,
    prompt:
      "Read last night's CI failures. For each one, decide whether it is flaky, a real regression, or an infra problem. File the real ones as issues with a minimal repro and link the failing run. Ignore anything already filed.",
    schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] },
    lastRunAt: NOW - 5 * HOUR,
    nextRunAt: NOW + 19 * HOUR,
    createdBy: NERB,
    runs: runs([
      ["ok", NOW - 5 * HOUR, NOW - 5 * HOUR + 94_000],
      ["ok", NOW - 29 * HOUR, NOW - 29 * HOUR + 141_000],
      ["skipped", NOW - 53 * HOUR, NOW - 53 * HOUR],
      ["ok", NOW - 77 * HOUR, NOW - 77 * HOUR + 88_000],
      ["ok", NOW - 101 * HOUR, NOW - 101 * HOUR + 203_000, "manual"],
    ]),
  },
  {
    id: "r-digest",
    sessionId: "s-relay",
    name: "Nightly digest",
    enabled: true,
    prompt:
      "Summarise what every agent in this workspace did today: what landed, what is still open, and what is blocked on me. Keep it under 200 words and lead with the blockers.",
    schedule: { kind: "daily", hour: 22, minute: 30, days: [] },
    lastRunAt: NOW - 14 * HOUR,
    nextRunAt: NOW + 9 * HOUR,
    createdBy: null,
    runs: runs([
      ["ok", NOW - 14 * HOUR, NOW - 14 * HOUR + 38_000],
      ["ok", NOW - 38 * HOUR, NOW - 38 * HOUR + 41_000],
      ["error", NOW - 62 * HOUR, NOW - 62 * HOUR + 4_000],
    ]),
  },
  {
    id: "r-deps",
    sessionId: "s-daemon",
    name: "Dependency sweep",
    enabled: false,
    prompt:
      "Run `cargo outdated` and `npm outdated`. Open a branch per major bump with the changelog entry quoted in the body. Never bump anything on master.",
    schedule: { kind: "cron", expression: "0 4 * * 1" },
    lastRunAt: NOW - 9 * DAY,
    nextRunAt: null,
    createdBy: NERB,
    runs: runs([
      ["ok", NOW - 9 * DAY, NOW - 9 * DAY + 612_000],
      ["ok", NOW - 16 * DAY, NOW - 16 * DAY + 540_000],
    ]),
  },
  {
    id: "r-index",
    sessionId: "s-daemon",
    name: "Reindex transcripts",
    enabled: true,
    prompt: "Rebuild the FTS5 index from the block store and report the row delta.",
    schedule: { kind: "interval", minutes: 180 },
    lastRunAt: NOW - 41 * MIN,
    nextRunAt: NOW + 139 * MIN,
    createdBy: null,
    runs: runs([
      ["running", NOW - 41 * MIN, null],
      ["ok", NOW - 3 * HOUR - 41 * MIN, NOW - 3 * HOUR - 39 * MIN],
      ["ok", NOW - 6 * HOUR - 41 * MIN, NOW - 6 * HOUR - 38 * MIN],
    ]),
  },
  {
    id: "r-docs",
    sessionId: "s-scribe",
    name: "Docs drift check",
    enabled: true,
    prompt:
      "Compare docs/ARCHITECTURE.md against the current crate layout. Report anything the doc claims that the code no longer does.",
    schedule: { kind: "interval", minutes: 60 },
    lastRunAt: NOW - 22 * MIN,
    nextRunAt: NOW + 38 * MIN,
    createdBy: NERB,
    runs: runs([
      ["error", NOW - 22 * MIN, NOW - 21 * MIN],
      ["ok", NOW - 82 * MIN, NOW - 81 * MIN],
      ["ok", NOW - 142 * MIN, NOW - 141 * MIN],
      ["skipped", NOW - 202 * MIN, NOW - 202 * MIN],
    ]),
  },
  {
    id: "r-standup",
    sessionId: "s-renderer",
    name: "Screenshot the shell",
    enabled: true,
    prompt: "Build the app, open it, screenshot every surface at both themes, and drop them in out/.",
    schedule: { kind: "daily", hour: 8, minute: 15, days: [1, 3, 5] },
    lastRunAt: NOW - 2 * DAY,
    nextRunAt: NOW + 17 * HOUR,
    createdBy: null,
    runs: runs([["ok", NOW - 2 * DAY, NOW - 2 * DAY + 77_000]]),
  },
];
