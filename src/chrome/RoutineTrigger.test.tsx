// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule } from "../lib/routines";
import { click, dispatch, mount, only, type, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { RoutineTrigger } from "./RoutineTrigger";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

const settle = () => act(async () => {});

function render(schedule: Schedule) {
  const onChange = vi.fn();
  view = mount(<RoutineTrigger schedule={schedule} onChange={onChange} />);
  return onChange;
}

const daily = (days: number[] = [], hour = 9, minute = 0): Schedule => ({ kind: "daily", hour, minute, days });
const day = (label: string) =>
  [...view!.container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((el) => el.textContent === label)!;

/** The whole sequence a real click sends: a select option commits on the release, not on `click` alone. */
function press(target: HTMLElement) {
  dispatch(target, new PointerEvent("pointerdown", { bubbles: true }));
  dispatch(target, new MouseEvent("mousedown", { bubbles: true }));
  dispatch(target, new PointerEvent("pointerup", { bubbles: true }));
  dispatch(target, new MouseEvent("mouseup", { bubbles: true }));
  click(target);
}

async function pickTrigger(label: string) {
  click(only(view!.container, '[aria-label="Trigger"]'));
  await settle();
  press([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes(label))!);
  await settle();
}

describe("RoutineTrigger", () => {
  it("moves a daily routine to the typed time", () => {
    const onChange = render(daily([], 9, 0));
    type(only<HTMLInputElement>(view!.container, 'input[aria-label="Time"]'), "18:45");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(daily([], 18, 45));
  });

  it("ignores a cleared time", () => {
    const onChange = render(daily());
    type(only<HTMLInputElement>(view!.container, 'input[aria-label="Time"]'), "");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds and removes weekdays", () => {
    const onChange = render(daily([1]));
    click(day("Wed"));
    expect(onChange).toHaveBeenLastCalledWith(daily([1, 3]));
    view?.unmount();

    const again = render(daily([1, 3]));
    click(day("Mon"));
    expect(again).toHaveBeenLastCalledWith(daily([3]));
  });

  it("keeps the last weekday, since a week with none never fires", () => {
    const onChange = render(daily([5]));
    click(day("Fri"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("edits a cron expression as typed", () => {
    const onChange = render({ kind: "cron", expression: "0 9 * * 1" });
    type(only<HTMLInputElement>(view!.container, 'input[aria-label="Cron expression"]'), "*/5 * * * *");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "cron", expression: "*/5 * * * *" });
  });

  it("switches cadence from the trigger menu, keeping the time", async () => {
    const onChange = render(daily([], 7, 30));
    await pickTrigger("Every week");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(daily([1], 7, 30));
  });

  it("changes nothing when an agent's own interval is picked again", async () => {
    const onChange = render({ kind: "interval", minutes: 45 });
    await pickTrigger("Every 45 minutes");
    expect(onChange).not.toHaveBeenCalled();
    await pickTrigger("Every hour");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: "interval", minutes: 60 });
  });
});
