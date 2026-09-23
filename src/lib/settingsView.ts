import type { SettingsSectionId } from "./settings";

export type SettingsBody = "appearance" | "keybindings" | "terminal" | "providers" | "pending";

/** The sections that are built show their panel; the rest say so. */
export function settingsBody(section: SettingsSectionId): SettingsBody {
  switch (section) {
    case "appearance":
    case "keybindings":
    case "terminal":
    case "providers":
      return section;
    default:
      return "pending";
  }
}
