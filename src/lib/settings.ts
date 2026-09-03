export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "providers", label: "Providers" },
  { id: "keybindings", label: "Keybindings" },
  { id: "about", label: "About" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_DEFAULT: SettingsSectionId = "general";

export function settingsSection(id: SettingsSectionId) {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
}
