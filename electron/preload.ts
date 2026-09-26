import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { CHANNELS, type DownloadActivity, type OpenTabRequest } from "../src/lib/browser/bridge";
import { FILE_CHANNELS } from "../src/lib/browser/files";
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
  files: {
    url: (root: string, path: string) => ipcRenderer.invoke(FILE_CHANNELS.url, root, path),
    reveal: (path: string) => ipcRenderer.invoke(FILE_CHANNELS.reveal, path),
    openExternal: (path: string) => ipcRenderer.invoke(FILE_CHANNELS.openExternal, path),
  },
  zoom: (delta: number) => ipcRenderer.invoke("app-zoom", delta),
  update: {
    current: () => ipcRenderer.invoke(UPDATE_CHANNELS.current),
    onState: (cb: (state: UpdateState) => void) => listen(UPDATE_CHANNELS.state, cb),
    install: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    dismiss: () => ipcRenderer.invoke(UPDATE_CHANNELS.dismiss),
    cancel: () => ipcRenderer.invoke(UPDATE_CHANNELS.cancel),
  },
  browser: {
    setCommands: (list: unknown) => ipcRenderer.send(CHANNELS.commands, list),
    setKeyboardLayout: (layout: unknown) => ipcRenderer.send(CHANNELS.keyboardLayout, layout),
    onCommand: (cb: (id: string) => void) => listen(CHANNELS.command, cb),
    onOpenTab: (cb: (request: OpenTabRequest) => void) => listen(CHANNELS.openTab, cb),
    onDownload: (cb: (activity: DownloadActivity) => void) => listen(CHANNELS.download, cb),
    toggleDevTools: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.devtools, webContentsId),
    snapshot: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.snapshot, webContentsId),
    prepareRestore: (token: string, entriesJson: string, index: number) =>
      ipcRenderer.invoke(CHANNELS.prepareRestore, token, entriesJson, index),
    favicon: (url: string, workspaceId: string) => ipcRenderer.invoke(CHANNELS.favicon, url, workspaceId),
    importCookies: (workspaceId: string, cookies: unknown) =>
      ipcRenderer.invoke(CHANNELS.importCookies, workspaceId, cookies),
  },
});
