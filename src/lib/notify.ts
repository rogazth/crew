import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let allowed: Promise<boolean> | null = null;

function permission(): Promise<boolean> {
  if (!allowed) {
    allowed = isPermissionGranted()
      .then((granted) => granted || requestPermission().then((state) => state === "granted"))
      .catch(() => false);
  }
  return allowed;
}

/** A native banner. Silent when the user said no; the app never nags for it twice. */
export async function notify(title: string, body: string): Promise<void> {
  if (!(await permission())) return;
  try {
    sendNotification({ title, body: body.slice(0, 200) });
  } catch {
    // The banner is a courtesy; the transcript already has the news.
  }
}
