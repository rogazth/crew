// @vitest-environment happy-dom
import { Sidebar } from "@cloudflare/kumo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SECTIONS } from "../lib/settings";
import { click, mount, type Mounted } from "../test/dom";
import { act } from "../test/renderHook";
import { SettingsSidebar } from "./SettingsSidebar";

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

async function render() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  view = mount(
    <Sidebar.Provider>
      <SettingsSidebar section="general" onSelect={onSelect} onClose={onClose} />
    </Sidebar.Provider>,
  );
  // The scroll area measures itself after the first paint.
  await act(async () => {});
  return { onSelect, onClose };
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text)!;

describe("SettingsSidebar", () => {
  it("opens each section by its row", async () => {
    const { onSelect } = await render();
    for (const section of SETTINGS_SECTIONS) click(button(section.label));
    expect(onSelect.mock.calls.map(([id]) => id)).toEqual(SETTINGS_SECTIONS.map((section) => section.id));
  });

  it("goes back to the session list", async () => {
    const { onClose, onSelect } = await render();
    click(button("Back"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
