// What each settings page is called, what it governs,
// where it sits in the nav, and a static index of the settings on it, so the
// nav's search can find a single row and jump to it.
import {
  BellIcon,
  BotIcon,
  GaugeIcon,
  GlobeIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { bindingGroups } from "../../lib/commandGroups";
import type { SettingsSectionId } from "../../lib/settings";

export type PageMeta = { id: SettingsSectionId; label: string; description: string; icon: LucideIcon };

export const PAGES: Record<SettingsSectionId, PageMeta> = {
  general: {
    id: "general",
    label: "General",
    description: "Worktrees, sessions and startup.",
    icon: SlidersHorizontalIcon,
  },
  appearance: {
    id: "appearance",
    label: "Appearance",
    description: "Theme, style and bot faces.",
    icon: PaletteIcon,
  },
  notifications: {
    id: "notifications",
    label: "Notifications",
    description: "Alerts and sounds.",
    icon: BellIcon,
  },
  keybindings: {
    id: "keybindings",
    label: "Keybindings",
    description: "Click a shortcut to change it.",
    icon: KeyboardIcon,
  },
  providers: {
    id: "providers",
    label: "Providers",
    description: "Coding agents and permissions.",
    icon: BotIcon,
  },
  usage: {
    id: "usage",
    label: "Usage",
    description: "Plan limits and when they reset.",
    icon: GaugeIcon,
  },
  environments: {
    id: "environments",
    label: "Environments",
    description: "Machines your sessions run on.",
    icon: ServerIcon,
  },
  terminal: {
    id: "terminal",
    label: "Terminal",
    description: "Font, size and spacing.",
    icon: SquareTerminalIcon,
  },
  browser: {
    id: "browser",
    label: "Browser",
    description: "Links, search and site permissions.",
    icon: GlobeIcon,
  },
  about: {
    id: "about",
    label: "About",
    description: "Version and updates.",
    icon: InfoIcon,
  },
};

/**
 * Pages whose redesigned version still runs on fake data. They are neither in
 * the nav nor in the search until their stream lands (S2 Usage), and
 * a request for one opens General instead.
 */
export const PENDING: readonly SettingsSectionId[] = ["usage"];

type NavGroup = { title: string | null; pages: SettingsSectionId[] };

const GROUPS: NavGroup[] = [
  { title: "App", pages: ["general", "appearance", "notifications", "keybindings"] },
  { title: "Agents", pages: ["providers", "usage", "environments"] },
  { title: "Tools", pages: ["terminal", "browser"] },
  { title: null, pages: ["about"] },
];

export const NAV_GROUPS: NavGroup[] = GROUPS.map((group) => ({
  ...group,
  pages: group.pages.filter((id) => !PENDING.includes(id)),
})).filter((group) => group.pages.length > 0);

/** One setting the search can find. `id` matches a row's `data-setting` on its page. */
export type IndexEntry = { id: string; label: string; page: SettingsSectionId; keywords?: string };

const SETTINGS: IndexEntry[] = [
  { id: "retention", label: "Delete inactive sessions", page: "general", keywords: "cleanup retention old" },
  { id: "notify-needs-you", label: "Dock badge", page: "notifications", keywords: "dock badge needs you waiting" },
  { id: "crew-command", label: "crew command", page: "general", keywords: "cli path terminal install" },
  { id: "bypass", label: "Bypass permissions", page: "general", keywords: "danger skip approvals yolo" },
  { id: "theme", label: "Theme", page: "appearance", keywords: "dark light mode system" },
  { id: "style", label: "Style and accent colour", page: "appearance", keywords: "brand ink crew cobalt teal blue" },
  { id: "avatar", label: "Bot avatar style", page: "appearance", keywords: "faces dicebear" },
  { id: "provider-claude", label: "Claude Code", page: "providers", keywords: "anthropic sign in" },
  { id: "provider-codex", label: "Codex", page: "providers", keywords: "openai chatgpt" },
  { id: "provider-opencode", label: "OpenCode", page: "providers", keywords: "sst install" },
  { id: "provider-cursor", label: "Cursor", page: "providers", keywords: "cursor-agent" },
  { id: "updates", label: "Check for updates", page: "about", keywords: "version upgrade release" },
  { id: "auto-download", label: "Download updates automatically", page: "about", keywords: "update upgrade background" },
  { id: "build", label: "Build", page: "about", keywords: "commit electron node version" },
  { id: "changelog", label: "What's new", page: "about", keywords: "changelog release notes" },
  { id: "licenses", label: "Licenses", page: "about", keywords: "open source third party notices acknowledgements" },
  { id: "notif-sound", label: "Notification sound", page: "notifications", keywords: "alert banner" },
  { id: "terminal-font", label: "Terminal font", page: "terminal", keywords: "mono ligatures size" },
  { id: "links-in-crew", label: "Open links in Crew", page: "browser", keywords: "default browser" },
  { id: "search-engine", label: "Search engine", page: "browser", keywords: "google duckduckgo address bar" },
  { id: "site-permissions", label: "Site permissions", page: "browser", keywords: "camera microphone" },
  { id: "machines", label: "Machines", page: "environments", keywords: "ssh tailscale remote environment server this mac" },
  { id: "add-machine", label: "Add a machine", page: "environments", keywords: "new environment remote ssh config tailscale install crewd server vm" },
  { id: "tailscale", label: "Tailscale", page: "environments", keywords: "tailnet network vpn" },
  { id: "warn-relay", label: "Relay warnings", page: "environments", keywords: "tailscale relay derp lag" },
  { id: "wake", label: "Reconnect on wake", page: "environments", keywords: "sleep heartbeat reconnect" },
  { id: "usage-limits", label: "Plan limits", page: "usage", keywords: "usage quota rate limit session weekly reset" },
  { id: "usage-rings", label: "Rings on the rail", page: "usage", keywords: "usage indicator rail widget" },
  { id: "usage-alerts", label: "Usage alerts", page: "usage", keywords: "notify warn limit threshold" },
];

let index: IndexEntry[] | null = null;

/** Every setting, then every command with a shortcut, so "zoom" finds Zoom In. */
export function settingsIndex(): IndexEntry[] {
  if (index) return index;
  const bindings = bindingGroups().flatMap((group) =>
    group.rows.map((row): IndexEntry => ({ id: `kb:${row.id}`, label: row.label, page: "keybindings", keywords: group.title })),
  );
  index = [...SETTINGS, ...bindings].filter((entry) => !PENDING.includes(entry.page));
  return index;
}
