// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDraft } from "../lib/routines";
import type { Session, Workspace } from "../lib/types";
import { deferred } from "../test/deferred";
import { click, dispatch, mount, type Mounted, type } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { RoutineEditor } from "./RoutineEditor";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const WORKSPACES: Workspace[] = [
  { id: "w1", name: "crew", path: "/w1", createdAt: 0 },
  { id: "w2", name: "site", path: "/w2", createdAt: 0 },
];

const BLANK: RoutineDraft = {
  key: "k",
  sessionId: "a1",
  name: "",
  enabled: true,
  prompt: "",
  schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
  runs: [],
};

function session(id: string, kind: Session["kind"] = "agent"): Session {
  return { id, kind, name: id, workspaceId: "w1" } as Session;
}

type Handlers = {
  onSave: ReturnType<typeof vi.fn<(draft: RoutineDraft) => Promise<void>>>;
  onDelete: ReturnType<typeof vi.fn<() => void>>;
  onRunNow: ReturnType<typeof vi.fn<() => Promise<void>>>;
  onBack: ReturnType<typeof vi.fn<() => void>>;
};

let view: Mounted;
let on: Handlers;

function render(initial: RoutineDraft, options: { saved?: boolean } = {}) {
  const saved = options.saved ?? true;
  view = mount(
    <RoutineEditor
      initial={initial}
      initialWorkspaceId="w1"
      workspaces={WORKSPACES}
      runs={[]}
      onSave={on.onSave}
      onDelete={saved ? on.onDelete : null}
      onRunNow={saved ? on.onRunNow : null}
      onBack={on.onBack}
    />,
  );
}

async function agents(list: Session[]) {
  await act(async () => fake.take("session_list").resolve(list));
}

function button(text: string): HTMLButtonElement | undefined {
  return [...view.container.querySelectorAll("button")].find((node) => node.textContent === text);
}

function field(placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  return view.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`)!;
}

/** Presses a button whose handler finishes after a promise, and lets it finish. */
async function press(target: Element) {
  click(target);
  await flush();
}

function fill(name: string, prompt: string) {
  type(field("e.g. Morning digest"), name);
  type(field("What the agent should do every time this routine fires."), prompt);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Picks an option in a kumo (base-ui) Select: open on click, commit on the pointer's release. */
async function choose(label: string, option: string) {
  click(view.container.querySelector(`[aria-label="${label}"]`)!);
  const target = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent === option)!;
  for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" };
    dispatch(target, name.startsWith("pointer") ? new PointerEvent(name, init) : new MouseEvent(name, init));
  }
  click(target);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.reset();
  on = {
    onSave: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(),
    onRunNow: vi.fn(() => Promise.resolve()),
    onBack: vi.fn(),
  };
});

afterEach(() => {
  view.unmount();
  vi.useRealTimers();
});

describe("RoutineEditor", () => {
  it("loads the agents of the routine's workspace", () => {
    render(BLANK);
    expect(fake.sent("session_list")).toEqual([{ workspaceId: "w1" }]);
  });

  it("will not save without a title and instructions", async () => {
    render(BLANK);
    await agents([session("a1")]);
    expect(button("Save")!.disabled).toBe(true);
    click(button("Save")!);
    type(field("e.g. Morning digest"), "Digest");
    expect(button("Save")!.disabled).toBe(true);
    await flush();
    expect(on.onSave).not.toHaveBeenCalled();
  });

  it("saves the edited routine", async () => {
    render(BLANK);
    await agents([session("a1")]);
    fill("Digest", "Summarize the night");
    await press(button("Save")!);
    expect(on.onSave).toHaveBeenCalledWith({ ...BLANK, name: "Digest", prompt: "Summarize the night" });
  });

  it("saves once however often Save is pressed while a save is running", async () => {
    const gate = deferred<void>();
    on.onSave.mockImplementation(() => gate.promise);
    render(BLANK);
    await agents([session("a1")]);
    fill("Digest", "Summarize the night");
    click(button("Save")!);
    click(button("Save")!);
    expect(on.onSave).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
    await press(button("Save")!);
    expect(on.onSave).toHaveBeenCalledTimes(2);
  });

  it("hands a routine whose agent is gone to the workspace's first agent", async () => {
    render({ ...BLANK, sessionId: "gone" });
    await agents([session("t1", "terminal"), session("b1"), session("b2")]);
    fill("Digest", "Summarize the night");
    await press(button("Save")!);
    expect(on.onSave.mock.calls[0]![0].sessionId).toBe("b1");
  });

  it("cannot save into a workspace that has no agents", async () => {
    render(BLANK);
    await agents([session("t1", "terminal")]);
    fill("Digest", "Summarize the night");
    expect(button("Save")!.disabled).toBe(true);
  });

  it("keeps the routine's agent when the agents cannot be listed", async () => {
    render(BLANK);
    await act(async () => fake.take("session_list").reject(new Error("daemon gone")));
    fill("Digest", "Summarize the night");
    await press(button("Save")!);
    expect(on.onSave.mock.calls[0]![0].sessionId).toBe("a1");
  });

  it("moves the routine to the first agent of the workspace it is moved to", async () => {
    render(BLANK);
    await agents([session("a1")]);
    await choose("Workspace", "site");
    expect(fake.sent("session_list")).toEqual([{ workspaceId: "w1" }, { workspaceId: "w2" }]);
    await agents([session("c1")]);
    fill("Digest", "Summarize the night");
    await press(button("Save")!);
    expect(on.onSave.mock.calls[0]![0].sessionId).toBe("c1");
  });

  it("ignores the first workspace's agents when they land after a move", async () => {
    render(BLANK);
    const first = fake.take("session_list");
    await choose("Workspace", "site");
    await agents([session("c1")]);
    await act(async () => first.resolve([session("x1")]));
    fill("Digest", "Summarize the night");
    await press(button("Save")!);
    expect(on.onSave.mock.calls[0]![0].sessionId).toBe("c1");
  });

  it("saves the schedule and switch as edited", async () => {
    render(BLANK);
    await agents([session("a1")]);
    fill("Digest", "Summarize the night");
    type(view.container.querySelector<HTMLInputElement>('[aria-label="Time"]')!, "07:30");
    click(view.container.querySelector('[role="switch"]')!);
    await press(button("Save")!);
    expect(on.onSave.mock.calls[0]![0]).toMatchObject({
      enabled: false,
      schedule: { kind: "daily", hour: 7, minute: 30, days: [] },
    });
  });

  it("will not save a cron expression that does not parse", async () => {
    render({ ...BLANK, name: "Digest", prompt: "Summarize", schedule: { kind: "cron", expression: "0 9 * * 1" } });
    await agents([session("a1")]);
    expect(button("Save")!.disabled).toBe(false);
    type(view.container.querySelector<HTMLInputElement>('[aria-label="Cron expression"]')!, "every monday");
    expect(button("Save")!.disabled).toBe(true);
  });

  it("shows why a manual run failed, and clears it on the next run", async () => {
    on.onRunNow.mockRejectedValueOnce(new Error("routine is gone"));
    render(BLANK);
    await agents([session("a1")]);
    await press(button("Run now")!);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("routine is gone");
    const gate = deferred<void>();
    on.onRunNow.mockImplementationOnce(() => gate.promise);
    click(button("Run now")!);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => gate.resolve());
  });

  it("runs once however often Run now is pressed while it runs", async () => {
    const gate = deferred<void>();
    on.onRunNow.mockImplementation(() => gate.promise);
    render(BLANK);
    await agents([session("a1")]);
    click(button("Run now")!);
    click(button("Run now")!);
    expect(on.onRunNow).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve());
  });

  it("goes back and deletes through its callbacks", async () => {
    render(BLANK);
    await agents([session("a1")]);
    click(button("Routines")!);
    click(view.container.querySelector('[aria-label="Delete routine"]')!);
    expect(on.onBack).toHaveBeenCalledTimes(1);
    expect(on.onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers neither run nor delete for a routine not saved yet", async () => {
    render(BLANK, { saved: false });
    await agents([session("a1")]);
    expect(button("Run now")).toBeUndefined();
    expect(view.container.querySelector('[aria-label="Delete routine"]')).toBeNull();
  });
});
