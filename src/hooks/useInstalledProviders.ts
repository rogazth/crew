import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { PROVIDERS, type ProviderDef } from "../lib/providers";

let known: ProviderDef[] | null = null;

/**
 * Providers whose CLI is on the user's PATH. Asks again whenever `refresh`
 * changes, so a CLI installed mid-session shows up without a restart. Until
 * the first answer every provider is offered: rows vanishing reads as broken,
 * rows appearing does not.
 */
export function useInstalledProviders(refresh?: unknown): ProviderDef[] {
  const [installed, setInstalled] = useState<ProviderDef[]>(known ?? PROVIDERS);

  useEffect(() => {
    let cancelled = false;
    api
      .installedBinaries(PROVIDERS.map((p) => p.binary))
      .then((found) => {
        known = PROVIDERS.filter((p) => found.includes(p.binary));
        if (!cancelled) setInstalled(known);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return installed;
}
