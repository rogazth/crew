import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULT, SETTINGS_SECTIONS, settingsSection, type SettingsSectionId } from "./settings";

describe("settingsSection", () => {
  it("finds a section by id", () => {
    expect(settingsSection("terminal")).toEqual({ id: "terminal", label: "Terminal" });
    expect(settingsSection(SETTINGS_DEFAULT)).toEqual({ id: "general", label: "General" });
  });

  it("falls back to the first section for an id that no longer exists", () => {
    expect(settingsSection("billing" as SettingsSectionId)).toBe(SETTINGS_SECTIONS[0]);
  });
});
