import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { PROVIDERS, loadListedModels, type ProviderDef } from "../lib/providers";

let known: ProviderDef[] | null = null;

/**
 * Providers whose CLI is on the user's PATH. Asks again whenever `refresh`
 * changes, so a CLI installed mid-session shows up without a restart, and
 * its models with it. Until the first answer every provider is offered: rows
 * vanishing reads as broken, rows appearing does not.
 */
export function useInstalledProviders(refresh?: unknown): ProviderDef[] {
  const [installed, setInstalled] = useState<ProviderDef[]>(known ?? PROVIDERS);

  useEffect(() => {
    let cancelled = false;
    api
      .installedBinaries(PROVIDERS.map((p) => p.binary))
      .then((found) => {
        known = PROVIDERS.filter((p) => found.includes(p.binary));
        // Read a CLI's own model list as soon as it is known to be there,
        // not when a picker first opens on it.
        for (const provider of known) loadListedModels(provider.id, api.listedModels);
        if (!cancelled) setInstalled(known);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return installed;
}
