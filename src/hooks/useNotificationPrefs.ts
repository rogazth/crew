import { useEffect, useSyncExternalStore } from "react";
import {
  loadNotificationPrefs,
  notificationPrefs,
  subscribeNotificationPrefs,
  updateNotificationPrefs,
} from "../lib/notificationPrefs";

/** The notification prefs, the same copy the dispatcher reads; a change applies to the next notification. */
export function useNotificationPrefs() {
  useEffect(() => void loadNotificationPrefs(), []);
  const prefs = useSyncExternalStore(subscribeNotificationPrefs, notificationPrefs);
  return { prefs, update: updateNotificationPrefs };
}
