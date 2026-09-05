import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("crewHost", {
  daemonInfo: () => ipcRenderer.invoke("daemon-info"),
  open: (opts: { multiple?: boolean; directory?: boolean }) => ipcRenderer.invoke("dialog-open", opts),
  homeDir: () => ipcRenderer.invoke("home-dir"),
  openUrl: (url: string) => ipcRenderer.invoke("open-url", url),
  notify: (title: string, body: string) => ipcRenderer.invoke("notify", { title, body }),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
});
