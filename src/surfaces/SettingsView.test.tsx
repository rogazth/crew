// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentThemeProvider } from "../hooks/useAgentTheme";
import { click, dispatch, mount, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { SettingsView } from "./SettingsView";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

let view: Mounted;

async function settle() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
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
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.reset();
  fake.respond("state_get", () => null);
  fake.respond("state_set", () => undefined);
  fake.respond("agent_installed", ({ names }) => names);
});

afterEach(() => {
  view.unmount();
  vi.useRealTimers();
});

describe("SettingsView", () => {
  it("stores the agent theme picked under Appearance", async () => {
    view = mount(
      <AgentThemeProvider>
        <SettingsView section="appearance" />
      </AgentThemeProvider>,
    );
    await settle();
    await choose("Agent theme", "Timeline");
    expect(fake.sent("state_set")).toEqual([{ key: "agent:theme", value: "timeline" }]);
  });

  it("stores the default agent picked under Providers", async () => {
    view = mount(<SettingsView section="providers" />);
    await settle();
    const trigger = [...view.container.querySelectorAll("button")].find((node) => node.textContent?.includes("Claude"))!;
    click(trigger);
    await settle();
    const model = [...document.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Sonnet 5"))!;
    click(model);
    await settle();
    expect(fake.sent("state_set")).toEqual([
      { key: "providers:default", value: JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }) },
    ]);
  });
});
