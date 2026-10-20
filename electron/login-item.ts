// Settings › General › Open at login: the app's own login item. It is separate
// from the crewd LaunchAgent (daemon-agent.ts), which is not loaded at login
// (plistPath keeps it out of ~/Library/LaunchAgents): crewd runs only once Crew
// starts it, so opening Crew at login is what keeps routines on schedule.

import { app, ipcMain } from "electron";
import { LOGIN_ITEM_CHANNELS, type LoginItemState } from "../src/lib/loginItem";

function loginItemState(): LoginItemState {
  // An unpackaged build would register Electron's own binary; Linux has no login items API.
  const supported = app.isPackaged && (process.platform === "darwin" || process.platform === "win32");
  return { supported, enabled: supported && app.getLoginItemSettings().openAtLogin };
}

export function registerLoginItemIpc(): void {
  ipcMain.handle(LOGIN_ITEM_CHANNELS.get, () => loginItemState());
  ipcMain.handle(LOGIN_ITEM_CHANNELS.set, (_event, enabled: boolean) => {
    if (loginItemState().supported) app.setLoginItemSettings({ openAtLogin: enabled === true });
    return loginItemState();
  });
}
