import { useCallback, useSyncExternalStore } from "react";
import type { DownloadInfo, PagePrompt } from "../lib/browser/bridge";
import { downloads } from "../lib/browser/downloads";
import { prompts } from "../lib/browser/prompts";

/** This window's downloads, newest first. */
export function useDownloads(): readonly DownloadInfo[] {
  return useSyncExternalStore(downloads.subscribe, downloads.list);
}

/** What one page is waiting on the person for, oldest first. */
export function usePagePrompts(webContentsId: number | null): readonly PagePrompt[] {
  const read = useCallback(() => prompts.forPage(webContentsId), [webContentsId]);
  return useSyncExternalStore(prompts.subscribe, read);
}
