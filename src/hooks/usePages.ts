import { useCallback, useState } from "react";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "../lib/settings";
import { newRoutineDraft } from "../lib/routines";
import type { Page } from "../surfaces/Pages";

/**
 * The page over the workspace, and the four ways it changes. Kept out of the
 * shell so `App` holds tabs and sessions, not a fifth kind of navigation.
 */
export function usePages() {
  const [page, setPage] = useState<Page>({ kind: "workspace" });

  const close = useCallback(() => setPage({ kind: "workspace" }), []);
  /** The same key that opened a page closes it. */
  const toggle = useCallback(
    (next: Page) => setPage((open) => (open.kind === next.kind ? { kind: "workspace" } : next)),
    [],
  );
  const openSettings = useCallback(
    (section: SettingsSectionId = SETTINGS_DEFAULT) => setPage({ kind: "settings", section }),
    [],
  );
  /** From an agent's drawer: the routines page, already editing a new one. */
  const openRoutines = useCallback(
    (sessionId?: string) =>
      setPage({
        kind: "routines",
        draft: sessionId === undefined ? null : newRoutineDraft(sessionId),
      }),
    [],
  );

  const openProcess = useCallback((processId: string) => setPage({ kind: "process", processId }), []);

  return {
    page,
    processId: page.kind === "process" ? page.processId : null,
    openProcess,
    settings: page.kind === "settings" ? page.section : null,
    isWorkspace: page.kind === "workspace",
    isRoutines: page.kind === "routines",
    close,
    toggle,
    openSettings,
    openRoutines,
  };
}
