// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import { DEFAULT_PREFS, type SidebarPrefs } from "../lib/sidebarPrefs";
import { click, mount, only, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { SidebarPrefsMenu } from "./SidebarPrefsMenu";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

const settle = () => act(async () => {});

async function render(prefs: SidebarPrefs = DEFAULT_PREFS) {
  const onChange = vi.fn();
  view = mount(<SidebarPrefsMenu prefs={prefs} onChange={onChange} />);
  click(only(view.container, 'button[aria-label="Customize sidebar"]'));
  await settle();
  return onChange;
}

const items = (role: string) => [...document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
const byText = (list: HTMLElement[], text: string) => list.find((el) => el.textContent?.trim().startsWith(text))!;

async function submenu(label: string) {
  click(byText(items("menuitem"), label));
  await settle();
}

async function choose(role: "menuitemradio" | "menuitemcheckbox", label: string) {
  click(byText(items(role), label));
  await settle();
}

describe("SidebarPrefsMenu", () => {
  it("changes the grouping", async () => {
    const onChange = await render();
    await submenu("Grouping");
    await choose("menuitemradio", "Provider");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFS, grouping: "provider" });
  });

  it("changes the ordering", async () => {
    const onChange = await render();
    await submenu("Ordering");
    await choose("menuitemradio", "Manual");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFS, ordering: "manual" });
  });

  it("hides and shows a row detail", async () => {
    const onChange = await render();
    await submenu("Show");
    await choose("menuitemcheckbox", "Avatar");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFS, show: ["provider", "updated", "status"] });

    const trimmed = { ...DEFAULT_PREFS, show: ["provider" as const] };
    view?.unmount();
    const again = await render(trimmed);
    await submenu("Show");
    await choose("menuitemcheckbox", "Status");
    expect(again).toHaveBeenCalledExactlyOnceWith({ ...trimmed, show: ["provider", "status"] });
  });

  it("filters out a kind of session", async () => {
    const onChange = await render();
    await submenu("Kind");
    await choose("menuitemcheckbox", "Agents");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFS, hiddenKinds: ["agent"] });
  });

  it("brings a hidden kind back", async () => {
    const prefs = { ...DEFAULT_PREFS, hiddenKinds: ["terminal" as const] };
    const onChange = await render(prefs);
    await submenu("Kind");
    await choose("menuitemcheckbox", "Sessions");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...prefs, hiddenKinds: [] });
  });

  it("filters out a provider", async () => {
    const onChange = await render();
    await submenu("Provider");
    await choose("menuitemcheckbox", "Codex");
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_PREFS, hiddenProviders: ["codex"] });
  });

  it("resets changed preferences to the defaults", async () => {
    const onChange = await render({ ...DEFAULT_PREFS, grouping: "none", hiddenProviders: ["cursor"] });
    click(byText(items("menuitem"), "Reset"));
    await settle();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_PREFS);
  });

  it("offers no reset while the defaults are on", async () => {
    const onChange = await render();
    click(byText(items("menuitem"), "Reset"));
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });
});
