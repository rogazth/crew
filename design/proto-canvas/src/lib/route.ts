import type { SettingsSectionId } from "@crew/fixtures";

/**
 * The hash contract the three prototypes share, so the same surfaces can be
 * screenshotted side by side. Unknown routes fall back rather than erroring.
 */
export type Route =
  | { kind: "session"; id: string }
  | { kind: "file"; path: string }
  | { kind: "search" }
  | { kind: "routines" }
  | { kind: "routine"; id: string }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "agents" }
  | { kind: "default" };

const SECTIONS = new Set<string>([
  "general",
  "appearance",
  "terminal",
  "providers",
  "keybindings",
  "about",
]);

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return { kind: "default" };
  const slash = raw.indexOf("/");
  const head = slash === -1 ? raw : raw.slice(0, slash);
  const rest = slash === -1 ? "" : decodeURIComponent(raw.slice(slash + 1));

  switch (head) {
    case "session":
      return rest ? { kind: "session", id: rest } : { kind: "default" };
    case "file":
      return rest ? { kind: "file", path: rest } : { kind: "default" };
    case "search":
      return { kind: "search" };
    case "routines":
      return rest ? { kind: "routine", id: rest } : { kind: "routines" };
    case "settings":
      return SECTIONS.has(rest)
        ? { kind: "settings", section: rest as SettingsSectionId }
        : { kind: "settings", section: "general" };
    case "agents":
      return { kind: "agents" };
    default:
      return { kind: "default" };
  }
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case "session":
      return `#/session/${route.id}`;
    case "file":
      return `#/file/${route.path}`;
    case "search":
      return "#/search";
    case "routines":
      return "#/routines";
    case "routine":
      return `#/routines/${route.id}`;
    case "settings":
      return `#/settings/${route.section}`;
    case "agents":
      return "#/agents";
    case "default":
      return "#/";
  }
}
