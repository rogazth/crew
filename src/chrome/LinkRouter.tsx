import { useEffect } from "react";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { routeLinks } from "../lib/external";

/** While the setting is on, chat and terminal links become Crew pages instead of leaving the app. */
export function LinkRouter({ open }: { open: (url: string) => void }) {
  const { prefs } = useBrowserPrefs();

  useEffect(() => {
    if (!prefs.openLinksInCrew) return;
    routeLinks(open);
    return () => routeLinks(null);
  }, [prefs.openLinksInCrew, open]);

  return null;
}
