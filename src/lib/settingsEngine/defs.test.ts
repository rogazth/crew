import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ALL_SETTINGS, GLOBAL_KEYS } from "./defs";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The files that may touch `app_state`, the window's memory: tabs, the worktree on
 * screen, widths, what was last opened. A choice in Settings does not belong
 * there: it goes through `defineSetting`, or it never reaches the other machines.
 */
const WINDOW_MEMORY = [
  "src/chrome/FolderBrowser.tsx",
  "src/chrome/MachinePalette.tsx",
  "src/hooks/useBotFaces.ts",
  "src/hooks/useExplorer.ts",
  "src/hooks/useExplorerRoot.ts",
  "src/hooks/useOutlinePref.ts",
  "src/hooks/useProviderJobs.ts",
  "src/hooks/useSidebarPrefs.ts",
  "src/hooks/useSidebarWidth.ts",
  "src/hooks/useTabs.ts",
  "src/hooks/useTour.ts",
  "src/hooks/useWorktrees.ts",
  "src/lib/api.ts",
  "src/lib/tabsMigration.ts",
  "src/surfaces/settings/integrations/vault.ts",
];

describe("the settings catalog", () => {
  test("each key is defined once", () => {
    const keys = ALL_SETTINGS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("names only settings that follow the user or stay on this computer", () => {
    for (const def of ALL_SETTINGS) expect(["global", "device"]).toContain(def.scope);
    expect(GLOBAL_KEYS).toContain("sessions:retention");
    expect(GLOBAL_KEYS).toContain("sessions:access");
  });

  test("every setting reads what it writes, and the default from nothing", () => {
    for (const def of ALL_SETTINGS) {
      const fallback = def.parse(null) as never;
      expect(def.parse(def.format(fallback))).toEqual(fallback);
      expect(def.parse("\u0000 not what it wrote")).toBeDefined();
    }
  });

  test("nothing else reads or writes a setting by hand", () => {
    const found = sources("src")
      .filter((path) => !path.includes("settingsEngine/") && !path.includes("lib/client/"))
      .filter((path) => /\bapi\.state(Get|Set|Delete)\(|\bstate(Get|Set|Delete)\b\s*[=(]|"state_(get|set|delete)"/.test(readFileSync(path, "utf8")));
    expect(found.sort()).toEqual([...WINDOW_MEMORY].sort());
  });
});
