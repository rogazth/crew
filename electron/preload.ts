import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  CHANNELS,
  type DockBounds,
  type DownloadAction,
  type DownloadInfo,
  type MountRequest,
  type OpenTabRequest,
  type PagePrompt,
  type PromptAnswer,
  type Responsiveness,
  type SitePermissions,
} from "../src/lib/browser/bridge";
import { FILE_CHANNELS } from "../src/lib/browser/files";
import type { InstallInput, InstallStep, ManualRemote } from "../src/lib/remotes";
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
    bindRemote: (root: string, envId: string) => ipcRenderer.invoke("files:bind-remote", root, envId),
    unbindRemote: (root: string) => ipcRenderer.invoke("files:unbind-remote", root),
  },
  remotes: {
    tailnet: () => ipcRenderer.invoke("remotes:tailnet"),
    sshHosts: () => ipcRenderer.invoke("remotes:ssh-hosts"),
    install: (input: InstallInput) => ipcRenderer.invoke("remotes:install", input),
    onProgress: (cb: (step: InstallStep) => void) => listen("remotes:progress", cb),
    update: (id: string) => ipcRenderer.invoke("remotes:update", id),
    restart: (id: string) => ipcRenderer.invoke("remotes:restart", id),
    remove: (id: string, wipe: boolean) => ipcRenderer.invoke("remotes:remove", id, wipe),
    logs: (id: string) => ipcRenderer.invoke("remotes:logs", id),
    token: (id: string) => ipcRenderer.invoke("remotes:token", id),
    add: (input: ManualRemote) => ipcRenderer.invoke("remotes:add", input),
    onWake: (cb: () => void) => listen("remotes:wake", cb),
  },
  zoom: (delta: number) => ipcRenderer.invoke("app-zoom", delta),
  colorMode: {
    get: () => ipcRenderer.invoke("color-mode-get"),
    set: (mode: string) => ipcRenderer.invoke("color-mode-set", mode),
  },
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
    onDownload: (cb: (download: DownloadInfo) => void) => listen(CHANNELS.downloads, cb),
    downloadAction: (id: string, action: DownloadAction) => ipcRenderer.invoke(CHANNELS.downloadAction, id, action),
    setAskWhereToSave: (ask: boolean) => ipcRenderer.send(CHANNELS.downloadPrefs, ask),
    onPrompt: (cb: (prompt: PagePrompt) => void) => listen(CHANNELS.prompt, cb),
    onPromptGone: (cb: (id: string) => void) => listen(CHANNELS.promptGone, cb),
    answer: (id: string, value: PromptAnswer) => ipcRenderer.send(CHANNELS.answer, id, value),
    setSitePermissions: (decisions: SitePermissions) => ipcRenderer.send(CHANNELS.sitePermissions, decisions),
    onResponsive: (cb: (state: Responsiveness) => void) => listen(CHANNELS.responsive, cb),
    kill: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.kill, webContentsId),
    print: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.print, webContentsId),
    toggleDevTools: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.devtools, webContentsId),
    dockDevTools: (webContentsId: number, bounds: DockBounds) =>
      ipcRenderer.invoke(CHANNELS.dockDevtools, webContentsId, bounds),
    placeDevTools: (webContentsId: number, bounds: DockBounds | null) =>
      ipcRenderer.invoke(CHANNELS.placeDevtools, webContentsId, bounds),
    closeDevTools: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.closeDevtools, webContentsId),
    snapshot: (webContentsId: number) => ipcRenderer.invoke(CHANNELS.snapshot, webContentsId),
    prepareRestore: (token: string, entriesJson: string, index: number) =>
      ipcRenderer.invoke(CHANNELS.prepareRestore, token, entriesJson, index),
    favicon: (url: string, workspaceId: string, incognito = false) =>
      ipcRenderer.invoke(CHANNELS.favicon, url, workspaceId, incognito),
    importCookies: (workspaceId: string, cookies: unknown) =>
      ipcRenderer.invoke(CHANNELS.importCookies, workspaceId, cookies),
    setProxy: (workspaceId: string, envId: string | null, socksPort: number | null) =>
      ipcRenderer.invoke("browser:set-proxy", workspaceId, envId, socksPort),
    reportGuest: (tab: string, webContentsId: number) => ipcRenderer.send(CHANNELS.pageGuest, tab, webContentsId),
    onMount: (cb: (request: MountRequest) => void) => listen(CHANNELS.mount, cb),
  },
});
