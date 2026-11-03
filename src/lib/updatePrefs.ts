import { updateHost } from "./host";
import { defineSetting } from "./settingsEngine/define";
import { peekSetting, readSetting, saveSetting, watchSetting } from "./settingsEngine/store";

export const autoDownloadSetting = defineSetting<boolean>({
  key: "updates:auto-download",
  scope: "device",
  fallback: false,
  parse: (raw) => raw === "true",
  format: String,
});

let telling = false;

/** The updater lives in main, which cannot read the daemon's state: it is told. */
function tell(): void {
  void updateHost()?.setAutoDownload(peekSetting(autoDownloadSetting));
}

export function autoDownload(): boolean {
  return peekSetting(autoDownloadSetting);
}

/** Reads the saved choice and hands it to the updater; a failed read leaves it off and tries again next time. */
export async function loadAutoDownload(): Promise<void> {
  if (!telling) {
    telling = true;
    watchSetting(autoDownloadSetting, tell);
  }
  await readSetting(autoDownloadSetting).then(tell, () => {});
}

export function saveAutoDownload(next: boolean): void {
  saveSetting(autoDownloadSetting, next);
}

export function subscribeAutoDownload(listener: () => void): () => void {
  return watchSetting(autoDownloadSetting, listener);
}
