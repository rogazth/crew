import { openUrl } from "./host";

/** Agent output is untrusted: only what a browser would follow leaves the app. */
const OPENABLE = /^(?:https?|mailto):/i;

export function openExternal(uri: string): void {
  if (!OPENABLE.test(uri)) return;
  void openUrl(uri).catch(() => {});
}
