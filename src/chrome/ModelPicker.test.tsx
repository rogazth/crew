// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));
// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { fake } from "../test/fakeClient";
import { click, mount, only, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { ModelPicker } from "./ModelPicker";

let view: Mounted | null = null;

beforeEach(() => {
  fake.reset();
  // Everything but opencode is on PATH.
  fake.respond("agent_installed", () => ["claude", "cursor-agent", "codex"]);
});

afterEach(() => {
  view?.unmount();
  view = null;
});

async function render(provider: string, model: string, trigger: "field" | "chip" = "field") {
  const onChange = vi.fn();
  view = mount(<ModelPicker provider={provider} model={model} trigger={trigger} onChange={onChange} />);
  await act(async () => {});
  return { onChange, trigger: only<HTMLButtonElement>(view.container, "button") };
}

/** Clicks, then lets the installed-CLI probe that opening and closing starts settle. */
async function press(target: HTMLElement) {
  click(target);
  await act(async () => {});
}

const open = press;

const tabs = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const tab = (label: string) => tabs().find((el) => el.title === label)!;
const model = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button:not([role="tab"])')].find(
    (el) => el.textContent?.startsWith(label),
  )!;

describe("ModelPicker", () => {
  it("picks a model of the current provider", async () => {
    const { trigger, onChange } = await render("claude", "");
    await open(trigger);
    await press(model("Sonnet 5"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("claude", "claude-sonnet-5");
  });

  it("picks the CLI default as an empty model", async () => {
    const { trigger, onChange } = await render("claude", "claude-opus-5");
    await open(trigger);
    await press(model("Default"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("claude", "");
  });

  it("switches provider through its tab", async () => {
    const { trigger, onChange } = await render("claude", "");
    await open(trigger);
    click(tab("Codex"));
    await press(model("GPT-6 Luna"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("codex", "gpt-6-luna");
  });

  it("closes after a pick", async () => {
    const { trigger } = await render("claude", "");
    await open(trigger);
    await press(model("Opus 5.5"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reopens on the current provider's tab", async () => {
    const { trigger } = await render("claude", "");
    await open(trigger);
    click(tab("Cursor"));
    await press(trigger);
    await open(trigger);
    expect(tab("Claude").getAttribute("aria-selected")).toBe("true");
    expect(tab("Cursor").getAttribute("aria-selected")).toBe("false");
  });

  it("offers installed providers only, plus the current one", async () => {
    const first = await render("claude", "");
    await open(first.trigger);
    expect(tabs().map((el) => el.title)).toEqual(["Claude", "Cursor", "Codex"]);
    view?.unmount();

    const second = await render("opencode", "");
    await open(second.trigger);
    expect(tabs().map((el) => el.title)).toEqual(["Claude", "Cursor", "Codex", "opencode"]);
  });

  it("asks which CLIs are installed each time it opens", async () => {
    const { trigger } = await render("claude", "");
    const before = fake.sent("agent_installed").length;
    await open(trigger);
    expect(fake.sent("agent_installed").length).toBe(before + 1);
  });

  it("does not open while disabled", async () => {
    const onChange = vi.fn();
    view = mount(<ModelPicker provider="claude" model="" trigger="chip" disabled onChange={onChange} />);
    const trigger = only<HTMLButtonElement>(view.container, "button");
    await open(trigger);
    expect(tabs()).toEqual([]);
  });
});
