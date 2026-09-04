export type OpenOptions = { multiple?: boolean; directory?: boolean };

export type DaemonInfo = { url: string; token: string };

type CrewHost = {
  daemonInfo(): Promise<DaemonInfo>;
  open(opts: OpenOptions): Promise<string | string[] | null>;
  homeDir(): Promise<string>;
  openUrl(url: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  pathForFile(file: File): string;
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

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function daemonInfo(): Promise<DaemonInfo> {
  const host = crewHost();
  if (host) return host.daemonInfo();
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DaemonInfo>("daemon_info");
  }
  throw new Error("Crew daemon is not available");
}

export async function open(opts: OpenOptions): Promise<string | string[] | null> {
  const host = crewHost();
  if (host) return host.open(opts);
  if (isTauri()) {
    const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
    return tauriOpen(opts);
  }
  return browserOpen(opts);
}

export async function homeDir(): Promise<string> {
  const host = crewHost();
  if (host) return host.homeDir();
  if (isTauri()) {
    const { homeDir: tauriHome } = await import("@tauri-apps/api/path");
    return tauriHome();
  }
  return "";
}

export async function openUrl(url: string): Promise<void> {
  const host = crewHost();
  if (host) return host.openUrl(url);
  if (isTauri()) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener");
    return tauriOpenUrl(url);
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

let allowed: Promise<boolean> | null = null;

export async function notify(title: string, body: string): Promise<void> {
  const host = crewHost();
  if (host) return host.notify(title, body);
  if (isTauri()) {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (!allowed) {
      allowed = isPermissionGranted()
        .then((granted) => granted || requestPermission().then((state) => state === "granted"))
        .catch(() => false);
    }
    if (!(await allowed)) return;
    sendNotification({ title, body });
    return;
  }
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
  if (isTauri() && !crewHost()) {
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") {
          handler({ type: payload.type, position: payload.position });
          return;
        }
        if (payload.type === "drop") {
          handler({ type: "drop", position: payload.position, paths: payload.paths });
          return;
        }
        handler({ type: "leave" });
      });
    });
    return;
  }
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
    handler({
      type: "drop",
      position: position(event),
      paths: files.map(pathForFile).filter(Boolean),
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
