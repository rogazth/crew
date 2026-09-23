// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Confirm } from "../chrome/ConfirmDialog";
import type { RoutineDraft, RoutineRow, ScheduledRoutine } from "../lib/routines";
import type { Session, Workspace } from "../lib/types";
import { click, mount, type Mounted, type } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { RoutinesView } from "./RoutinesView";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const WORKSPACES: Workspace[] = [{ id: "w1", name: "crew", path: "/w1", createdAt: 0 }];

function agent(id: string): Session {
  return { id, kind: "agent", name: `Agent ${id}`, workspaceId: "w1", provider: "claude" } as Session;
}

function row(id: string, name: string, enabled = true): ScheduledRoutine {
  const routine: RoutineRow = {
    id,
    sessionId: "a1",
    name,
    enabled,
    prompt: "Summarize the night",
    schedule: JSON.stringify({ kind: "daily", hour: 9, minute: 0, days: [] }),
    lastRunAt: null,
    nextRunAt: null,
    runsJson: "[]",
    createdBy: null,
  };
  return { routine, session: agent("a1"), cwd: "/w1" };
}

let view: Mounted;
let rows: ScheduledRoutine[];
let onConfirm: ReturnType<typeof vi.fn<(confirm: Confirm) => void>>;

async function render(options: { agents?: Session[]; draft?: RoutineDraft | null } = {}) {
  view = mount(
    <RoutinesView
      draft={options.draft ?? null}
      workspaces={WORKSPACES}
      activeWorkspaceId="w1"
      agents={options.agents ?? [agent("a1"), agent("a2")]}
      onConfirm={onConfirm}
    />,
  );
  await settle();
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return [...view.container.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
}

/** The editor is up once it has asked for the agents it may hand the routine to. */
function editorOpened(): boolean {
  return fake.sent("session_list").length > 0;
}

beforeEach(() => {
  fake.reset();
  rows = [];
  onConfirm = vi.fn();
  fake.respond("routine_list", () => rows);
  fake.respond("session_list", () => [agent("a1"), agent("a2")]);
});

afterEach(() => {
  view.unmount();
});

describe("RoutinesView", () => {
  it("cannot start a routine without an agent to run it", async () => {
    await render({ agents: [] });
    expect(button("New routine")!.disabled).toBe(true);
    click(button("New routine")!);
    await settle();
    expect(editorOpened()).toBe(false);
  });

  it("starts a new routine on the first agent and keeps editing it once saved", async () => {
    fake.respond("routine_upsert", () => {
      rows = [row("r-new", "Digest")];
      return rows[0]!.routine;
    });
    await render();
    click(button("New routine")!);
    await settle();
    expect(fake.sent("session_list")).toEqual([{ workspaceId: "w1" }]);
    type(view.container.querySelector("[placeholder='e.g. Morning digest']")!, "Digest");
    type(view.container.querySelector("textarea")!, "Summarize the night");
    click(button("Save")!);
    await settle();
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ sessionId: "a1", name: "Digest" });
    click(button("Run now")!);
    await settle();
    expect(fake.sent("routine_run_now")).toEqual([{ routineId: "r-new" }]);
  });

  it("opens a routine's editor from its card", async () => {
    rows = [row("r1", "Morning digest")];
    await render();
    click(button("Morning digest")!);
    await settle();
    click(button("Run now")!);
    await settle();
    expect(fake.sent("routine_run_now")).toEqual([{ routineId: "r1" }]);
  });

  it("goes back to the list from the editor", async () => {
    rows = [row("r1", "Morning digest")];
    await render();
    click(button("Morning digest")!);
    await settle();
    click(button("Routines")!);
    expect(button("New routine")).toBeDefined();
  });

  it("asks before deleting, and deleting takes the routine and closes the editor", async () => {
    rows = [row("r1", "Morning digest")];
    fake.respond("routine_delete", () => {
      rows = [];
      return undefined;
    });
    await render();
    click(button("Morning digest")!);
    await settle();
    click(view.container.querySelector("[aria-label='Delete routine']")!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const confirm = onConfirm.mock.calls[0]![0];
    expect(confirm).toMatchObject({ title: 'Delete routine "Morning digest"?', action: "Delete" });
    expect(fake.sent("routine_delete")).toEqual([]);
    await act(async () => confirm.onConfirm());
    await settle();
    expect(fake.sent("routine_delete")).toEqual([{ id: "r1" }]);
    expect(button("New routine")).toBeDefined();
  });

  it("opens straight into a draft handed in from an agent", async () => {
    const draft: RoutineDraft = {
      key: "from-drawer",
      sessionId: "a2",
      name: "",
      enabled: true,
      prompt: "",
      schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
      runs: [],
    };
    fake.respond("routine_upsert", () => row("r-new", "Digest").routine);
    await render({ draft });
    expect(editorOpened()).toBe(true);
    type(view.container.querySelector("[placeholder='e.g. Morning digest']")!, "Digest");
    type(view.container.querySelector("textarea")!, "Summarize the night");
    click(button("Save")!);
    await settle();
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ sessionId: "a2" });
  });

  it("shows only paused routines under Paused", async () => {
    rows = [row("r1", "Morning digest"), row("r2", "Weekly review", false)];
    await render();
    click([...view.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Paused")!);
    expect(button("Weekly review")).toBeDefined();
    expect(button("Morning digest")).toBeUndefined();
  });
  it("saves an edited routine under its own id and stays in the editor", async () => {
    rows = [row("r1", "Morning digest")];
    fake.respond("routine_upsert", () => rows[0]!.routine);
    await render();
    click(button("Morning digest")!);
    await settle();
    type(view.container.querySelector("[placeholder='e.g. Morning digest']")!, "Evening digest");
    click(button("Save")!);
    await settle();
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ id: "r1", name: "Evening digest" });
    expect(button("Run now")).toBeDefined();
  });
});
