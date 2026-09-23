// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPrefsProvider } from "../hooks/useTerminalPrefs";
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from "../lib/terminalPrefs";
import { click, mount, only, press, type, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { TerminalSettings } from "./TerminalSettings";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

let view: Mounted | null = null;

beforeEach(() => {
  fake.reset();
  fake.respond("state_set", () => undefined);
});

afterEach(() => {
  view?.unmount();
  view = null;
});

async function render(stored: Partial<TerminalPrefs> | null = null) {
  fake.respond("state_get", () => (stored ? JSON.stringify({ ...DEFAULT_TERMINAL_PREFS, ...stored }) : null));
  view = mount(
    <TerminalPrefsProvider>
      <TerminalSettings />
    </TerminalPrefsProvider>,
  );
  await act(async () => {});
}

function stepper(label: string) {
  const input = only<HTMLInputElement>(view!.container, `input[aria-label="${label}"]`);
  const box = input.parentElement!;
  return {
    input,
    smaller: only<HTMLButtonElement>(box, 'button[aria-label="Smaller"]'),
    larger: only<HTMLButtonElement>(box, 'button[aria-label="Larger"]'),
    reset: only<HTMLButtonElement>(box.parentElement!, 'button[aria-label="Reset to default"]'),
  };
}

function saved(): TerminalPrefs[] {
  return fake.sent("state_set").map((params) => JSON.parse(String(params.value)) as TerminalPrefs);
}

function blur(input: HTMLInputElement) {
  act(() => input.blur());
}

describe("TerminalSettings steppers", () => {
  it("commits a typed size on blur, clamped into range", async () => {
    await render();
    const size = stepper("Font size");
    act(() => size.input.focus());
    type(size.input, "40");
    blur(size.input);
    expect(saved().map((prefs) => prefs.fontSize)).toEqual([32]);
    expect(stepper("Font size").input.value).toBe("32");
  });

  it("commits on Enter, snapped to the step", async () => {
    await render();
    const height = stepper("Line height");
    act(() => height.input.focus());
    type(height.input, "1.26");
    press(height.input, "Enter");
    expect(saved()).toEqual([{ ...DEFAULT_TERMINAL_PREFS, lineHeight: 1.3 }]);
  });

  it("restores the value on Escape and then commits nothing", async () => {
    await render();
    const size = stepper("Font size");
    act(() => size.input.focus());
    type(size.input, "20");
    press(size.input, "Escape");
    expect(size.input.value).toBe(String(DEFAULT_TERMINAL_PREFS.fontSize));
    blur(size.input);
    expect(saved()).toEqual([]);
  });

  it("steps with the buttons by the field's own step", async () => {
    await render();
    click(stepper("Font size").larger);
    click(stepper("Font weight").smaller);
    expect(saved().map(({ fontSize, fontWeight }) => ({ fontSize, fontWeight }))).toEqual([
      { fontSize: 15, fontWeight: 500 },
      { fontSize: 15, fontWeight: 400 },
    ]);
  });

  it("offers no step past a limit", async () => {
    await render({ fontSize: 32, lineHeight: 1 });
    expect(stepper("Font size").larger.disabled).toBe(true);
    expect(stepper("Font size").smaller.disabled).toBe(false);
    expect(stepper("Line height").smaller.disabled).toBe(true);
  });

  it("resets a changed value to its default", async () => {
    await render({ fontSize: 20, fontWeightBold: 800 });
    click(stepper("Font size").reset);
    expect(saved().at(-1)).toEqual({ ...DEFAULT_TERMINAL_PREFS, fontWeightBold: 800 });
    expect(stepper("Font size").input.value).toBe(String(DEFAULT_TERMINAL_PREFS.fontSize));
  });
});

describe("TerminalSettings font family", () => {
  it("resets a chosen font to the system one", async () => {
    await render({ fontFamily: "Fira Code" });
    const picker = only(view!.container, '[aria-label="Font family"]');
    click(only(picker.parentElement!.parentElement!, 'button[aria-label="Reset to default"]'));
    expect(saved()).toEqual([DEFAULT_TERMINAL_PREFS]);
  });
});
