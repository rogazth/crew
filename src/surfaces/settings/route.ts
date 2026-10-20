// A page asking the settings window to open another page ("Manage providers"
// on a machine opens Providers). The nav listens.
import { useEffect, useSyncExternalStore } from "react";
import { LOCAL } from "../../lib/client/registry";
import type { SettingsSectionId } from "../../lib/settings";
import { requestJump } from "./ui";

let viewing: string = LOCAL;
const viewers = new Set<() => void>();

/** The machine the Providers page shows. */
export function useProvidersEnv(): string {
  return useSyncExternalStore(
    (listener) => {
      viewers.add(listener);
      return () => viewers.delete(listener);
    },
    () => viewing,
  );
}

export function setProvidersEnv(id: string) {
  viewing = id;
  viewers.forEach((listener) => listener());
}

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
