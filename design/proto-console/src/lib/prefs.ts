export type Grouping = "none" | "kind" | "provider" | "status" | "lineage";
export type Ordering = "manual" | "updated" | "name";
export type ShowKey = "provider" | "updated" | "status" | "avatar";

export type SidebarPrefs = {
  grouping: Grouping;
  ordering: Ordering;
  show: Record<ShowKey, boolean>;
  hiddenKinds: string[];
  hiddenProviders: string[];
  collapsedGroups: string[];
};

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  grouping: "kind",
  ordering: "manual",
  show: { provider: true, updated: true, status: true, avatar: false },
  hiddenKinds: [],
  hiddenProviders: [],
  collapsedGroups: [],
};

export type Theme = "light" | "dark" | "system";
export type Density = "comfortable" | "compact";

export type TerminalPrefs = {
  fontFamily: string;
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
};

export const DEFAULT_TERMINAL: TerminalPrefs = {
  fontFamily: "ui-monospace",
  fontSize: 12.5,
  cursorStyle: "block",
};

const KEY = "crew-console:";

export function load<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY + name);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    // A pref shape that changed between runs must not brick the app.
    if (parsed && typeof parsed === "object" && typeof fallback === "object" && fallback) {
      return { ...(fallback as object), ...(parsed as object) } as T;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function save(name: string, value: unknown): void {
  try {
    localStorage.setItem(KEY + name, JSON.stringify(value));
  } catch {
    /* private mode, quota, disabled storage — preferences are not load-bearing */
  }
}
