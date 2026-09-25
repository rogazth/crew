import type { DownloadActivity, OpenTabRequest } from "./browser/bridge";
import type { NavSnapshot } from "./browser/snapshot";
import type { KeyboardLayout, LiveCommand } from "./keymap";
import type { UpdateState } from "./update";

export type OpenOptions = { multiple?: boolean; directory?: boolean };

export type DaemonInfo = { url: string; token: string };

type CrewHost = {
  daemonInfo(): Promise<DaemonInfo>;
  open(opts: OpenOptions): Promise<string | string[] | null>;
  homeDir(): Promise<string>;
  openUrl(url: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  pathForFile(file: File): string;
  update: UpdateHost;
  browser: BrowserHost;
};

/** The updater's main-process half. Absent outside Electron. */
export type UpdateHost = {
  current(): Promise<UpdateState>;
  onState(cb: (state: UpdateState) => void): () => void;
  install(): Promise<void>;
  dismiss(): Promise<void>;
  cancel(): Promise<void>;
};

/** The browser's main-process half. Absent outside Electron (the mock, the screenshot build). */
export type BrowserHost = {
  setCommands(list: LiveCommand[]): void;
  setKeyboardLayout(layout: KeyboardLayout): void;
  onCommand(cb: (id: string) => void): () => void;
  onOpenTab(cb: (request: OpenTabRequest) => void): () => void;
  onDownload(cb: (activity: DownloadActivity) => void): () => void;
  /** Resolves whether DevTools are open afterwards. */
  toggleDevTools(webContentsId: number): Promise<boolean>;
  snapshot(webContentsId: number): Promise<NavSnapshot | null>;
  prepareRestore(token: string, entriesJson: string, index: number): Promise<boolean>;
  favicon(url: string): Promise<string | null>;
};

export type HostDragDrop =
  | { type: "enter" | "over"; position: { x: number; y: number } }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

declare global {
  interface Window {
    crewHost?: CrewHost;
  }
}

function crewHost(): CrewHost | undefined {
  return typeof window !== "undefined" ? window.crewHost : undefined;
}

export function browserHost(): BrowserHost | null {
  return crewHost()?.browser ?? null;
}

export function updateHost(): UpdateHost | null {
  return crewHost()?.update ?? null;
}

export async function daemonInfo(): Promise<DaemonInfo> {
  const host = crewHost();
  if (host) return host.daemonInfo();
  throw new Error("Crew daemon is not available");
}

export async function open(opts: OpenOptions): Promise<string | string[] | null> {
  const host = crewHost();
  if (host) return host.open(opts);
  return browserOpen(opts);
}

export async function homeDir(): Promise<string> {
  const host = crewHost();
  if (host) return host.homeDir();
  return "";
}

function allowedUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

export async function openUrl(url: string): Promise<void> {
  if (!allowedUrl(url)) return;
  const host = crewHost();
  if (host) return host.openUrl(url);
  window.open(url, "_blank", "noopener,noreferrer");
}

let allowed: Promise<boolean> | null = null;

export async function notify(title: string, body: string): Promise<void> {
  const host = crewHost();
  if (host) return host.notify(title, body);
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "denied") return;
  if (Notification.permission !== "granted") {
    if (!allowed) {
      allowed = Notification.requestPermission()
        .then((state) => state === "granted")
        .catch(() => false);
    }
    if (!(await allowed)) return;
  }
  new Notification(title, { body });
}

export function pathForFile(file: File): string {
  const host = crewHost();
  if (host) return host.pathForFile(file);
  const path = "path" in file && typeof file.path === "string" ? file.path : "";
  return path;
}

export function onDragDrop(handler: (event: HostDragDrop) => void): void {
  listenDomDrops(handler);
}

function listenDomDrops(handler: (event: HostDragDrop) => void): void {
  const ratio = () => window.devicePixelRatio || 1;
  const position = (event: DragEvent) => {
    const scale = ratio();
    return { x: event.clientX * scale, y: event.clientY * scale };
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    handler({ type: "over", position: position(event) });
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget) return;
    handler({ type: "leave" });
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
    const paths: string[] = [];
    for (const file of files) {
      try {
        const path = pathForFile(file);
        if (!path) {
          console.error(`Drop rejected: no filesystem path for ${file.name || "file"}`);
          continue;
        }
        paths.push(path);
      } catch (error) {
        console.error("Drop rejected:", error instanceof Error ? error.message : error);
      }
    }
    handler({
      type: "drop",
      position: position(event),
      paths,
    });
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
}

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");
}

function browserOpen(opts: OpenOptions): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!opts.multiple;
    if (opts.directory) input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }
      if (opts.directory) {
        const dir = directoryOf(files[0]!);
        resolve(opts.multiple ? files.map(browserPath) : dir);
        return;
      }
      const paths = files.map(browserPath);
      resolve(opts.multiple ? paths : (paths[0] ?? null));
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function browserPath(file: File): string {
  return pathForFile(file) || file.webkitRelativePath || file.name;
}

function directoryOf(file: File): string {
  const path = pathForFile(file);
  const relative = file.webkitRelativePath;
  if (path && relative && path.endsWith(relative)) {
    return path.slice(0, -relative.length).replace(/\/$/, "") || path;
  }
  if (path) {
    const slash = path.lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : path;
  }
  const slash = relative.indexOf("/");
  return slash === -1 ? file.name : relative.slice(0, slash);
}
