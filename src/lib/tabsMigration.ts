import * as api from "./api";
import { parseTabs, persistedTabs, type TabState } from "./tabs";

/**
 * Tabs used to be kept per worktree, under `tabs:{workspace}@{path}`, with
 * `tabs:scope` recording the choice. They are now one strip per workspace, so
 * the worktree strips are folded into it once.
 */

/** `base` with the tabs of each legacy strip appended, a tab id already there skipped. */
export function mergeLegacyTabs(base: TabState, legacy: TabState[]): TabState {
  const known = new Set(base.tabs.map((tab) => tab.id));
  const tabs = [...base.tabs];
  for (const strip of legacy)
    for (const tab of strip.tabs) {
      if (known.has(tab.id)) continue;
      known.add(tab.id);
      tabs.push(tab);
    }
  return tabs.length === base.tabs.length ? base : { ...base, tabs };
}

/** The workspace a `tabs:{workspace}@{path}` key belongs to; null for any other key. */
export function legacyWorkspace(key: string): string | null {
  if (!key.startsWith("tabs:")) return null;
  const at = key.indexOf("@");
  return at > 5 ? key.slice(5, at) : null;
}

async function migrate(): Promise<void> {
  try {
    const keys = await api.stateKeys("tabs:");
    const byWorkspace = new Map<string, string[]>();
    for (const key of keys) {
      const workspace = legacyWorkspace(key);
      if (workspace) byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), key]);
    }
    for (const [workspace, legacyKeys] of byWorkspace) {
      const base = parseTabs(await api.stateGet(`tabs:${workspace}`));
      const legacy = await Promise.all(legacyKeys.map((key) => api.stateGet(key).then(parseTabs)));
      const merged = mergeLegacyTabs(base, legacy);
      if (merged !== base) await api.stateSet(`tabs:${workspace}`, JSON.stringify(persistedTabs(merged)));
      await Promise.all(legacyKeys.map((key) => api.stateDelete(key)));
    }
    if (keys.includes("tabs:scope")) await api.stateDelete("tabs:scope");
  } catch {
    // A daemon without the listing, or one that is unreachable: tried again on the next launch.
  }
}

let done: Promise<void> | null = null;

/** Folds the worktree strips in, once per run; every read of a saved strip waits for it. */
export function migrateLegacyTabs(): Promise<void> {
  return (done ??= migrate());
}
