// PROTOTYPE — throwaway. A page asking the settings window to open another
// page ("Manage providers" on a machine opens Providers). Whoever owns the
// section — the standalone prototype, or the nav in the app — listens.
import { useEffect } from "react";
import type { SettingsSectionId } from "../../../lib/settings";
import { setProvidersEnv } from "./envMock";
import { requestJump } from "./ui";

const listeners = new Set<(section: SettingsSectionId) => void>();

export function requestSection(section: SettingsSectionId) {
  listeners.forEach((listener) => listener(section));
}

/** Calls `open` whenever a page asks for another section. */
export function useSectionRequests(open: (section: SettingsSectionId) => void) {
  useEffect(() => {
    listeners.add(open);
    return () => {
      listeners.delete(open);
    };
  }, [open]);
}

/** Opens Providers on one machine, scrolled to its CLIs. */
export function manageProviders(envId: string) {
  setProvidersEnv(envId);
  requestJump("providers-env");
  requestSection("providers");
}
