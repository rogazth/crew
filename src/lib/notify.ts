import { notify as hostNotify } from "./host";

/** A native banner. Silent when the user said no; the app never nags for it twice. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    await hostNotify(title, body.slice(0, 200));
  } catch {
    // The banner is a courtesy; the transcript already has the news.
  }
}
