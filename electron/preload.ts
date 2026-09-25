import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { CHANNELS, type DownloadActivity, type OpenTabRequest } from "../src/lib/browser/bridge";
import { UPDATE_CHANNELS, type UpdateState } from "../src/lib/update";

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

contextBridge.exposeInMainWorld("crewHost", {
  daemonInfo: () => ipcRenderer.invoke("daemon-info"),
  open: (opts: { multiple?: boolean; directory?: boolean }) => ipcRenderer.invoke("dialog-open", opts),
  homeDir: () => ipcRenderer.invoke("home-dir"),
  openUrl: (url: string) => ipcRenderer.invoke("open-url", url),
  notify: (title: string, body: string) => ipcRenderer.invoke("notify", { title, body }),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  update: {
    current: () => ipcRenderer.invoke(UPDATE_CHANNELS.current),
    onState: (cb: (state: UpdateState) => void) => listen(UPDATE_CHANNELS.state, cb),
    install: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    dismiss: () => ipcRenderer.invoke(UPDATE_CHANNELS.dismiss),
    cancel: () => ipcRenderer.invoke(UPDATE_CHANNELS.cancel),
  },
  browser: {
    setCommands: (list: unknown) => ipcRenderer.send(CHANNELS.commands, list),
    onCommand: (cb: (id: string) => void) => listen(CHANNELS.command, cb),
    onOpenTab: (cb: (request: OpenTabRequest) => void) => listen(CHANNELS.openTab, cb),
    onDownload: (cb: (activity: DownloadActivity) => void) => listen(CHANNELS.download, cb),
    toggleDevTools: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.devtools, webContentsId),
    snapshot: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.snapshot, webContentsId),
    prepareRestore: (token: string, entriesJson: string, index: number) =>
      ipcRenderer.invoke(CHANNELS.prepareRestore, token, entriesJson, index),
    favicon: (url: string) => ipcRenderer.invoke(CHANNELS.favicon, url),
  },
});
