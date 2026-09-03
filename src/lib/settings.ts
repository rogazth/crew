export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", blurb: "App-wide behaviour and the build you are running." },
  { id: "appearance", label: "Appearance", blurb: "Theme and the density of the chrome." },
  { id: "terminal", label: "Terminal", blurb: "Typography for every terminal and session." },
  { id: "providers", label: "Providers", blurb: "Agent CLIs crew can drive, and the model new sessions start with." },
  { id: "keybindings", label: "Keybindings", blurb: "Every shortcut the app handles." },
  { id: "about", label: "About", blurb: "Version and credits." },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_DEFAULT: SettingsSectionId = "general";

export function settingsSection(id: SettingsSectionId) {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
}
