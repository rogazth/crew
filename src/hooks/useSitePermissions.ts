import { useEffect } from "react";
import { sitePermissionsSetting, type SitePermissions } from "../lib/browser/permissions";
import { browserHost } from "../lib/host";
import { peekSetting, readSetting, setSetting, useSetting, watchSetting } from "../lib/settingsEngine/store";

let loaded: Promise<void> | null = null;

/** Main holds a copy to answer pages without asking. */
function publish(): void {
  browserHost()?.setSitePermissions(peekSetting(sitePermissionsSetting));
}

/** Read once per window; later calls share the first read. */
export function loadSitePermissions(): Promise<void> {
  if (!loaded) {
    watchSetting(sitePermissionsSetting, publish);
    loaded = readSetting(sitePermissionsSetting).then(publish, publish);
  }
  return loaded;
}

/** Applied once the saved decisions are in, so an answer given during the read is not lost to it. */
export async function changeSitePermissions(change: (current: SitePermissions) => SitePermissions): Promise<void> {
  await loadSitePermissions();
  await setSetting(sitePermissionsSetting, change(peekSetting(sitePermissionsSetting))).catch(() => {});
}

export function useSitePermissions(): SitePermissions {
  useEffect(() => {
    void loadSitePermissions();
  }, []);
  return useSetting(sitePermissionsSetting);
}
