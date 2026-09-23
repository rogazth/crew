import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "./settings";
import { settingsBody } from "./settingsView";

describe("settingsBody", () => {
  it("shows the built panels for their own sections", () => {
    expect(settingsBody("appearance")).toBe("appearance");
    expect(settingsBody("keybindings")).toBe("keybindings");
    expect(settingsBody("terminal")).toBe("terminal");
    expect(settingsBody("providers")).toBe("providers");
  });

  it("says the rest are not built yet", () => {
    expect(settingsBody("general")).toBe("pending");
    expect(settingsBody("about")).toBe("pending");
  });

  it("gives every section exactly one body", () => {
    const bodies = SETTINGS_SECTIONS.map((section) => settingsBody(section.id));
    expect(bodies.filter((body) => body !== "pending")).toHaveLength(4);
  });
});
