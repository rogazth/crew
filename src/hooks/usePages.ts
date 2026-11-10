import { useCallback, useState } from "react";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "../lib/settings";
import { newRoutineDraft } from "../lib/routines";
import type { ServiceOpen } from "../surfaces/ServicesView";
import type { Page } from "../surfaces/Pages";

/**
 * The page over the workspace, and the ways it changes. Kept out of the
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
  /** `sessionId`: the session whose Connectors chip led here, for what its project has. */
  const openSettings = useCallback(
    (section: SettingsSectionId = SETTINGS_DEFAULT, sessionId?: string) =>
      setPage({ kind: "settings", section, ...(sessionId !== undefined && { sessionId }) }),
    [],
  );
  /** The Services page, on its list or on what covers it: a service, a run's output, a new one. */
  const openServices = useCallback((view: ServiceOpen | null = null) => setPage({ kind: "services", ...(view && { view }) }), []);
  /** From a bot's drawer: the routines page, already editing a new one. */
  const openRoutines = useCallback(
    (sessionId?: string) =>
      setPage({
        kind: "routines",
        draft: sessionId === undefined ? null : newRoutineDraft(sessionId),
      }),
    [],
  );
  /** From a bot's drawer: the routines page, editing one of its routines. */
  const openRoutine = useCallback((id: string) => setPage({ kind: "routines", draft: null, editId: id }), []);

  return {
    page,
    settings: page.kind === "settings" ? page.section : null,
    isWorkspace: page.kind === "workspace",
    isRoutines: page.kind === "routines",
    close,
    toggle,
    openSettings,
    openServices,
    openRoutines,
    openRoutine,
  };
}
